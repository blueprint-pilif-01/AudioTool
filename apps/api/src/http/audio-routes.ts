import { rename, rm } from "node:fs/promises";

import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { createPlaybackPreview, extractWaveformPeaks, probeAudio } from "@audiotool/audio-engine";
import { audioAssets, projects } from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import { serializeAsset } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const assetParams = z.object({ assetId: z.string().uuid() });
const waveformQuery = z.object({
  points: z.coerce.number().int().min(64).max(4_096).default(1_024),
});
const waveformCache = new Map<string, Promise<number[]>>();
const playbackPreviewJobs = new Map<string, Promise<string>>();
const playbackPreviewWaiters: Array<() => void> = [];
let activePlaybackPreviews = 0;

function rememberWaveform(key: string, waveform: Promise<number[]>) {
  waveformCache.set(key, waveform);
  if (waveformCache.size > 256) {
    const oldest = waveformCache.keys().next().value;
    if (oldest) waveformCache.delete(oldest);
  }
  waveform.catch(() => waveformCache.delete(key));
  return waveform;
}

async function withPlaybackPreviewSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activePlaybackPreviews >= 2) {
    await new Promise<void>((resolve) => playbackPreviewWaiters.push(resolve));
  }
  activePlaybackPreviews += 1;
  try {
    return await task();
  } finally {
    activePlaybackPreviews -= 1;
    playbackPreviewWaiters.shift()?.();
  }
}

async function ensurePlaybackPreview(storageKey: string, context: ApiContext): Promise<string> {
  const previewKey = `${storageKey}.mixer-preview-v1.mp3`;
  const existingJob = playbackPreviewJobs.get(previewKey);
  if (existingJob) return existingJob;
  try {
    const existing = await context.storage.stat(previewKey);
    if (existing.size > 0) return previewKey;
  } catch {
    // A missing or incomplete derivative is generated below.
  }

  const job = withPlaybackPreviewSlot(async () => {
    const temporaryKey = `${previewKey}.tmp.mp3`;
    const temporaryPath = context.storage.resolveKey(temporaryKey);
    await rm(temporaryPath, { force: true });
    try {
      await createPlaybackPreview(
        context.storage.resolveKey(storageKey),
        temporaryPath,
        context.config.FFMPEG_PATH,
      );
      await rename(temporaryPath, context.storage.resolveKey(previewKey));
      return previewKey;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  });
  playbackPreviewJobs.set(previewKey, job);
  void job.then(
    () => playbackPreviewJobs.delete(previewKey),
    () => playbackPreviewJobs.delete(previewKey),
  );
  return job;
}

async function sendAudioFile(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ApiContext,
  storageKey: string,
  mimeType: string,
  cacheControl?: string,
  maxOpenRangeBytes?: number,
) {
  const fileStats = await context.storage.stat(storageKey);
  const rangeHeader = request.headers.range;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", mimeType);
  if (cacheControl) reply.header("Cache-Control", cacheControl);
  if (!rangeHeader) {
    reply.header("Content-Length", fileStats.size);
    return reply.send(context.storage.createReadStream(storageKey));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) throw new AppError(416, "INVALID_RANGE", "Invalid byte range.");
  const hasStart = Boolean(match[1]);
  const hasEnd = Boolean(match[2]);
  const suffixLength = !hasStart && hasEnd ? Number.parseInt(match[2]!, 10) : 0;
  const start = hasStart
    ? Number.parseInt(match[1]!, 10)
    : Math.max(0, fileStats.size - suffixLength);
  const requestedEnd =
    !hasStart && hasEnd
      ? fileStats.size - 1
      : hasEnd
        ? Number.parseInt(match[2]!, 10)
        : fileStats.size - 1;
  const openRangeEnd =
    hasStart && !hasEnd && maxOpenRangeBytes ? start + maxOpenRangeBytes - 1 : requestedEnd;
  const end = Math.min(openRangeEnd, fileStats.size - 1);
  if (start < 0 || start > end || start >= fileStats.size) {
    reply.header("Content-Range", `bytes */${fileStats.size}`);
    throw new AppError(416, "RANGE_NOT_SATISFIABLE", "The requested byte range is unavailable.");
  }
  reply
    .status(206)
    .header("Content-Range", `bytes ${start}-${end}/${fileStats.size}`)
    .header("Content-Length", end - start + 1);
  return reply.send(context.storage.createReadStream(storageKey, { start, end }));
}

export function registerAudioRoutes(app: FastifyInstance, context: ApiContext) {
  app.post("/api/projects/:projectId/audio", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const [project] = await context.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound("Project");
    const file = await request.file();
    if (!file) throw new AppError(400, "AUDIO_FILE_REQUIRED", "Select an audio file to upload.");

    const upload = await context.storage.storeUpload(
      projectId,
      file.filename,
      file.mimetype,
      file.file,
    );
    try {
      const metadata = await probeAudio(upload.absolutePath, context.config.FFPROBE_PATH);
      if (metadata.durationMs <= 0) {
        throw new AppError(
          422,
          "INVALID_AUDIO_DURATION",
          "The audio duration could not be determined.",
        );
      }
      if (metadata.durationMs > context.config.MAX_AUDIO_DURATION_MS) {
        throw new AppError(
          413,
          "AUDIO_TOO_LONG",
          `The audio exceeds the ${Math.round(context.config.MAX_AUDIO_DURATION_MS / 60_000)} minute duration limit.`,
        );
      }
      const [duplicate] = await context.db
        .select()
        .from(audioAssets)
        .where(
          and(
            eq(audioAssets.projectId, projectId),
            eq(audioAssets.checksumSha256, upload.checksumSha256),
            isNull(audioAssets.deletedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        await context.storage.remove(upload.storageKey);
        await context.db
          .update(projects)
          .set({ sourceAudioId: duplicate.id, status: "draft", updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        return reply.send({ asset: serializeAsset(duplicate), deduplicated: true });
      }
      const [asset] = await context.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(audioAssets)
          .values({
            projectId,
            kind: "source",
            storageProvider: context.storage.providerName,
            storageKey: upload.storageKey,
            originalFilename: upload.originalFilename,
            mimeType: upload.mimeType,
            extension: upload.extension,
            sizeBytes: upload.sizeBytes,
            checksumSha256: upload.checksumSha256,
            durationMs: metadata.durationMs,
            sampleRate: metadata.sampleRate,
            channels: metadata.channels,
            codec: metadata.codec,
            bitrate: metadata.bitrate,
            metadata: { formatName: metadata.formatName },
          })
          .returning();
        if (!inserted[0]) throw new Error("Audio asset insert did not return a row.");
        await tx
          .update(projects)
          .set({ sourceAudioId: inserted[0].id, status: "draft", updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        return inserted;
      });
      if (!asset) throw new Error("Audio asset transaction did not return a row.");
      return reply.status(201).send({ asset: serializeAsset(asset) });
    } catch (error) {
      await context.storage.remove(upload.storageKey);
      throw error;
    }
  });

  app.get("/api/audio/:assetId", async (request) => {
    const { assetId } = assetParams.parse(request.params);
    const [asset] = await context.db
      .select()
      .from(audioAssets)
      .where(eq(audioAssets.id, assetId))
      .limit(1);
    if (!asset) throw notFound("Audio asset");
    return { asset: serializeAsset(asset) };
  });

  app.get("/api/audio/:assetId/waveform", async (request, reply) => {
    const { assetId } = assetParams.parse(request.params);
    const { points } = waveformQuery.parse(request.query);
    const [asset] = await context.db
      .select()
      .from(audioAssets)
      .where(eq(audioAssets.id, assetId))
      .limit(1);
    if (!asset) throw notFound("Audio asset");
    const fileStats = await context.storage.stat(asset.storageKey);
    const cacheKey = `${asset.id}:${fileStats.size}:${fileStats.mtimeMs}:${points}`;
    const peaks = await (waveformCache.get(cacheKey) ??
      rememberWaveform(
        cacheKey,
        extractWaveformPeaks(
          context.storage.resolveKey(asset.storageKey),
          points,
          context.config.FFMPEG_PATH,
        ),
      ));
    reply.header("Cache-Control", "private, max-age=86400");
    return { peaks, durationMs: asset.durationMs };
  });

  app.get("/api/audio/:assetId/stream", async (request, reply) => {
    const { assetId } = assetParams.parse(request.params);
    const [asset] = await context.db
      .select()
      .from(audioAssets)
      .where(eq(audioAssets.id, assetId))
      .limit(1);
    if (!asset) throw notFound("Audio asset");
    return sendAudioFile(request, reply, context, asset.storageKey, asset.mimeType);
  });

  app.get("/api/audio/:assetId/playback", async (request, reply) => {
    const { assetId } = assetParams.parse(request.params);
    const [asset] = await context.db
      .select()
      .from(audioAssets)
      .where(eq(audioAssets.id, assetId))
      .limit(1);
    if (!asset) throw notFound("Audio asset");
    const previewKey = await ensurePlaybackPreview(asset.storageKey, context);
    reply.header("X-AudioTool-Playback-Preview", "mp3-192k");
    return sendAudioFile(
      request,
      reply,
      context,
      previewKey,
      "audio/mpeg",
      "private, max-age=31536000, immutable",
      1_024 * 1_024,
    );
  });
}
