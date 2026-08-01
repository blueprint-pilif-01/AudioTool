import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { probeAudio } from "@audiotool/audio-engine";
import {
  generateGuideTracksSchema,
  guideCueSchema,
  timeSignatureDenominatorSchema,
  type GeneratedProjectTrack,
} from "@audiotool/contracts";
import { audioAssets, mixSessions, mixTracks, projects } from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import {
  guideCueTimeMs,
  listGuideVoices,
  renderClickTrack,
  renderGuideTrack,
} from "../services/guide-track-service.js";
import { serializeAsset } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const guideVoicePreviewSchema = z.object({
  text: z.string().trim().min(1).max(160),
  voiceName: z.string().min(1),
  speechRate: z.number().int().min(-5).max(5).default(1),
});
const generatedMetadataSchema = z.object({
  generatedTrackType: z.enum(["guide", "click"]),
  bpm: z.number(),
  beatsPerBar: z.number().int(),
  beatUnit: timeSignatureDenominatorSchema,
  voiceName: z.string().optional(),
  speechRate: z.number().int().optional(),
  cues: z.array(guideCueSchema).optional(),
});

type GeneratedType = "guide" | "click";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function toGeneratedTrack(asset: typeof audioAssets.$inferSelect): GeneratedProjectTrack | null {
  const metadata = generatedMetadataSchema.safeParse(asset.metadata);
  if (!metadata.success) return null;
  return {
    type: metadata.data.generatedTrackType,
    asset: serializeAsset(asset),
    settings: {
      bpm: metadata.data.bpm,
      beatsPerBar: metadata.data.beatsPerBar,
      beatUnit: metadata.data.beatUnit,
      ...(metadata.data.voiceName ? { voiceName: metadata.data.voiceName } : {}),
      ...(metadata.data.speechRate === undefined ? {} : { speechRate: metadata.data.speechRate }),
      ...(metadata.data.cues ? { cues: metadata.data.cues } : {}),
    },
  };
}

async function loadProjectSource(projectId: string, context: ApiContext) {
  const [row] = await context.db
    .select({ project: projects, source: audioAssets })
    .from(projects)
    .leftJoin(audioAssets, eq(projects.sourceAudioId, audioAssets.id))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Project");
  if (!row.source || row.source.deletedAt) {
    throw new AppError(
      409,
      "SOURCE_AUDIO_REQUIRED",
      "Upload source audio before creating guide and click tracks.",
    );
  }
  return row.source;
}

export function registerGuideTrackRoutes(app: FastifyInstance, context: ApiContext) {
  const groqApiKey = context.config.GROQ_API_KEY?.trim();
  const loadVoices = () =>
    listGuideVoices({
      provider: context.config.GUIDE_TTS_PROVIDER,
      mlWorkerUrl: context.config.ML_WORKER_URL,
      ...(groqApiKey ? { groqApiKey } : {}),
    });

  app.get("/api/projects/:projectId/guide-tracks", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const source = await loadProjectSource(projectId, context);
    const [voices, assets] = await Promise.all([
      loadVoices(),
      context.db
        .select()
        .from(audioAssets)
        .where(
          and(
            eq(audioAssets.projectId, projectId),
            eq(audioAssets.kind, "preview"),
            isNull(audioAssets.deletedAt),
          ),
        )
        .orderBy(asc(audioAssets.createdAt)),
    ]);
    return {
      durationMs: source.durationMs,
      cloudTtsConfigured: Boolean(groqApiKey),
      neuralTtsAvailable: voices.some(
        (voice) => voice.provider === "groq" || voice.provider === "edge",
      ),
      voices,
      tracks: assets.flatMap((asset) => {
        const track = toGeneratedTrack(asset);
        return track ? [track] : [];
      }),
    };
  });

  app.post("/api/projects/:projectId/guide-voice-preview", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = guideVoicePreviewSchema.parse(request.body);
    await loadProjectSource(projectId, context);
    const voice = (await loadVoices()).find((candidate) => candidate.name === body.voiceName);
    if (!voice) {
      throw new AppError(
        422,
        "GUIDE_VOICE_UNAVAILABLE",
        "The selected guide voice is unavailable.",
      );
    }
    const output = await context.storage.createOutputPath(projectId, "guide-preview", ".wav");
    try {
      await renderGuideTrack({
        cues: [{ id: randomUUID(), bar: 1, beat: 1, text: body.text }],
        bpm: 120,
        beatsPerBar: 4,
        durationMs: Math.min(20_000, Math.max(4_000, body.text.length * 90)),
        voice,
        speechRate: body.speechRate,
        outputPath: output.absolutePath,
        ffmpegPath: context.config.FFMPEG_PATH,
        ...(groqApiKey ? { groqApiKey } : {}),
        groqModel: context.config.GROQ_TTS_MODEL,
        mlWorkerUrl: context.config.ML_WORKER_URL,
      });
      const audio = await readFile(output.absolutePath);
      return reply
        .type("audio/wav")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", 'inline; filename="guide-preview.wav"')
        .send(audio);
    } finally {
      await context.storage.remove(output.storageKey).catch(() => undefined);
    }
  });

  app.post("/api/projects/:projectId/guide-tracks", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = generateGuideTracksSchema.parse(request.body);
    const source = await loadProjectSource(projectId, context);
    const outOfRangeCue = body.cues.find(
      (cue) => guideCueTimeMs(cue, body.bpm, body.beatsPerBar) >= source.durationMs,
    );
    if (body.createGuide && outOfRangeCue) {
      throw new AppError(
        422,
        "GUIDE_CUE_OUT_OF_RANGE",
        `The cue at bar ${outOfRangeCue.bar}, beat ${outOfRangeCue.beat} is outside the song.`,
      );
    }

    const voices = body.createGuide ? await loadVoices() : [];
    const requestedVoice = body.voiceName
      ? voices.find((voice) => voice.name === body.voiceName)
      : (voices.find((voice) => voice.name === context.config.GROQ_TTS_VOICE) ??
        voices.find((voice) => voice.provider === "edge" && voice.name === "en-US-JennyNeural") ??
        voices.find((voice) => voice.gender === "Female") ??
        voices[0]);
    if (body.createGuide && !requestedVoice) {
      throw new AppError(
        422,
        "GUIDE_VOICE_UNAVAILABLE",
        "No guide voice is available. Check the ML worker or configure GROQ_API_KEY.",
      );
    }

    const outputs: Array<{
      type: GeneratedType;
      storageKey: string;
      absolutePath: string;
      volumeDb: number;
    }> = [];
    try {
      if (body.createGuide && requestedVoice) {
        const output = await context.storage.createOutputPath(projectId, "guide-track", ".wav");
        outputs.push({ type: "guide", ...output, volumeDb: body.guideVolumeDb });
        await renderGuideTrack({
          cues: [...body.cues].sort(
            (left, right) =>
              guideCueTimeMs(left, body.bpm, body.beatsPerBar) -
              guideCueTimeMs(right, body.bpm, body.beatsPerBar),
          ),
          bpm: body.bpm,
          beatsPerBar: body.beatsPerBar,
          durationMs: source.durationMs,
          voice: requestedVoice,
          speechRate: body.speechRate,
          outputPath: output.absolutePath,
          ffmpegPath: context.config.FFMPEG_PATH,
          ...(groqApiKey ? { groqApiKey } : {}),
          groqModel: context.config.GROQ_TTS_MODEL,
          mlWorkerUrl: context.config.ML_WORKER_URL,
        });
      }
      if (body.createClick) {
        const output = await context.storage.createOutputPath(projectId, "click-track", ".wav");
        outputs.push({ type: "click", ...output, volumeDb: body.clickVolumeDb });
        await renderClickTrack({
          bpm: body.bpm,
          beatsPerBar: body.beatsPerBar,
          durationMs: source.durationMs,
          outputPath: output.absolutePath,
          ffmpegPath: context.config.FFMPEG_PATH,
        });
      }

      const rendered = await Promise.all(
        outputs.map(async (output) => {
          const [metadata, checksumSha256, fileStats] = await Promise.all([
            probeAudio(output.absolutePath, context.config.FFPROBE_PATH),
            sha256File(output.absolutePath),
            stat(output.absolutePath),
          ]);
          return { ...output, metadata, checksumSha256, sizeBytes: fileStats.size };
        }),
      );

      const existingAssets = await context.db
        .select()
        .from(audioAssets)
        .where(
          and(
            eq(audioAssets.projectId, projectId),
            eq(audioAssets.kind, "preview"),
            isNull(audioAssets.deletedAt),
          ),
        );
      const replacedTypes = new Set(outputs.map((output) => output.type));
      const replacedAssets = existingAssets.filter((asset) => {
        const metadata = generatedMetadataSchema.safeParse(asset.metadata);
        return metadata.success && replacedTypes.has(metadata.data.generatedTrackType);
      });
      const replacedAssetIds = replacedAssets.map((asset) => asset.id);

      const inserted = await context.db.transaction(async (tx) => {
        if (replacedAssetIds.length > 0) {
          await tx.delete(mixTracks).where(inArray(mixTracks.audioAssetId, replacedAssetIds));
          await tx.delete(audioAssets).where(inArray(audioAssets.id, replacedAssetIds));
        }

        let [session] = await tx
          .select()
          .from(mixSessions)
          .where(eq(mixSessions.projectId, projectId))
          .orderBy(asc(mixSessions.createdAt))
          .limit(1);
        if (!session) {
          [session] = await tx
            .insert(mixSessions)
            .values({ projectId, name: "Main mix", masterSettings: { volumeDb: 0 } })
            .returning();
        }
        if (!session) throw new Error("Mix session insert did not return a row.");

        const currentTracks = await tx
          .select({ orderIndex: mixTracks.orderIndex })
          .from(mixTracks)
          .where(eq(mixTracks.mixSessionId, session.id))
          .orderBy(asc(mixTracks.orderIndex));
        let nextOrder = currentTracks.reduce(
          (maximum, track) => Math.max(maximum, track.orderIndex + 1),
          0,
        );
        const created: Array<{
          type: GeneratedType;
          asset: typeof audioAssets.$inferSelect;
        }> = [];
        for (const output of rendered) {
          const [asset] = await tx
            .insert(audioAssets)
            .values({
              projectId,
              kind: "preview",
              storageProvider: context.storage.providerName,
              storageKey: output.storageKey,
              originalFilename: `${output.type}-track.wav`,
              mimeType: "audio/wav",
              extension: ".wav",
              sizeBytes: output.sizeBytes,
              checksumSha256: output.checksumSha256,
              durationMs: output.metadata.durationMs,
              sampleRate: output.metadata.sampleRate,
              channels: output.metadata.channels,
              codec: output.metadata.codec,
              bitrate: output.metadata.bitrate,
              metadata: {
                generatedTrackType: output.type,
                bpm: body.bpm,
                beatsPerBar: body.beatsPerBar,
                beatUnit: body.beatUnit,
                ...(output.type === "guide"
                  ? {
                      voiceName: requestedVoice?.name,
                      voiceProvider: requestedVoice?.provider,
                      speechRate: body.speechRate,
                      cues: body.cues,
                    }
                  : {}),
                generatedAt: new Date().toISOString(),
                version: 1,
              },
            })
            .returning();
          if (!asset) throw new Error("Generated audio asset insert did not return a row.");
          await tx.insert(mixTracks).values({
            mixSessionId: session.id,
            stemId: null,
            audioAssetId: asset.id,
            orderIndex: nextOrder,
            startMs: 0,
            trimStartMs: 0,
            trimEndMs: 0,
            volumeDb: output.volumeDb,
            pan: 0,
            muted: false,
            solo: false,
            settings: { enabled: true },
            fadeInMs: 0,
            fadeOutMs: 0,
          });
          nextOrder += 1;
          created.push({ type: output.type, asset });
        }
        return created;
      });

      await Promise.allSettled(
        replacedAssets.map((asset) => context.storage.remove(asset.storageKey)),
      );
      return reply.status(201).send({
        tracks: inserted.flatMap(({ type, asset }) => {
          const track = toGeneratedTrack(asset);
          return track ? [{ ...track, type }] : [];
        }),
      });
    } catch (error) {
      await Promise.allSettled(outputs.map((output) => context.storage.remove(output.storageKey)));
      throw error;
    }
  });
}
