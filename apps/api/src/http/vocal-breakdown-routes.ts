import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { probeAudio } from "@audiotool/audio-engine";
import {
  generateVocalBreakdownSchema,
  vocalBreakdownParts,
  type VocalBreakdownAnalysis,
  type VocalBreakdownPart,
  type VocalBreakdownTrack,
} from "@audiotool/contracts";
import { audioAssets, mixSessions, mixTracks, projects, stems } from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import { serializeAsset, serializeStem } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const displayNames: Record<VocalBreakdownPart, string> = {
  melody: "Melody guide",
  soprano: "Soprano focus",
  alto: "Alto focus",
  tenor: "Tenor focus",
  bass: "Bass focus",
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function breakdownPart(metadata: Record<string, unknown>): VocalBreakdownPart | null {
  const value = metadata.vocalBreakdownPart;
  return vocalBreakdownParts.includes(value as VocalBreakdownPart)
    ? (value as VocalBreakdownPart)
    : null;
}

function breakdownAnalysis(metadata: Record<string, unknown>): VocalBreakdownAnalysis | null {
  const value = metadata.vocalBreakdownAnalysis;
  if (!value || typeof value !== "object") return null;
  const analysis = value as Partial<VocalBreakdownAnalysis>;
  return analysis.methodology === "dominant-pitch-register-gating" &&
    Array.isArray(analysis.notes) &&
    Array.isArray(analysis.registers)
    ? (analysis as VocalBreakdownAnalysis)
    : null;
}

function toTrack(asset: typeof audioAssets.$inferSelect): VocalBreakdownTrack | null {
  const part = breakdownPart(asset.metadata);
  if (!part) return null;
  return {
    part,
    displayName: displayNames[part],
    asset: serializeAsset(asset),
    confidence: typeof asset.metadata.confidence === "number" ? asset.metadata.confidence : 0,
    coverage: typeof asset.metadata.coverage === "number" ? asset.metadata.coverage : 0,
  };
}

async function loadVocalStem(projectId: string, context: ApiContext) {
  const [project] = await context.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw notFound("Project");
  const [row] = await context.db
    .select({ stem: stems, asset: audioAssets })
    .from(stems)
    .innerJoin(audioAssets, eq(stems.audioAssetId, audioAssets.id))
    .where(and(eq(stems.projectId, projectId), eq(stems.canonicalLabel, "vocals")))
    .orderBy(desc(stems.createdAt))
    .limit(1);
  if (!row) {
    throw new AppError(
      409,
      "VOCAL_STEM_REQUIRED",
      "Create a Vocals stem before opening Vocal Breakdown.",
    );
  }
  return row;
}

export function registerVocalBreakdownRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/api/projects/:projectId/vocal-breakdown", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const vocal = await loadVocalStem(projectId, context);
    const assets = await context.db
      .select()
      .from(audioAssets)
      .where(
        and(
          eq(audioAssets.projectId, projectId),
          eq(audioAssets.kind, "preview"),
          isNull(audioAssets.deletedAt),
        ),
      )
      .orderBy(asc(audioAssets.createdAt));
    const breakdownAssets = assets.filter((asset) => breakdownPart(asset.metadata));
    const analysis = breakdownAssets
      .map((asset) => breakdownAnalysis(asset.metadata))
      .find((value) => value !== null);
    return {
      vocalStem: serializeStem(vocal.stem, "Vocals"),
      durationMs: vocal.asset.durationMs,
      analysis: analysis ?? null,
      tracks: breakdownAssets.flatMap((asset) => {
        const track = toTrack(asset);
        return track ? [track] : [];
      }),
    };
  });

  app.post("/api/projects/:projectId/vocal-breakdown", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = generateVocalBreakdownSchema.parse(request.body);
    const vocal = await loadVocalStem(projectId, context);
    const vocalPath = context.storage.resolveKey(vocal.asset.storageKey);
    const analysis = await context.provider.analyzeVocalBreakdown({
      audioPath: vocalPath,
      checksum: vocal.asset.checksumSha256,
      durationMs: vocal.asset.durationMs,
    });
    const outputs: Array<{
      part: VocalBreakdownPart;
      storageKey: string;
      absolutePath: string;
      confidence: number;
      coverage: number;
      provider: string;
      modelName: string;
      modelVersion: string;
    }> = [];

    try {
      for (const part of body.parts) {
        const output = await context.storage.createOutputPath(projectId, `vocal-${part}`, ".wav");
        const result = await context.provider.renderVocalBreakdownPart({
          audioPath: vocalPath,
          checksum: vocal.asset.checksumSha256,
          durationMs: vocal.asset.durationMs,
          part,
          outputPath: output.absolutePath,
        });
        outputs.push({ part, ...output, ...result });
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
      const replacedParts = new Set(body.parts);
      const replacedAssets = existingAssets.filter((asset) => {
        const part = breakdownPart(asset.metadata);
        return part !== null && replacedParts.has(part);
      });
      const replacedIds = replacedAssets.map((asset) => asset.id);

      const inserted = await context.db.transaction(async (tx) => {
        if (replacedIds.length > 0) {
          await tx.delete(mixTracks).where(inArray(mixTracks.audioAssetId, replacedIds));
          await tx.delete(audioAssets).where(inArray(audioAssets.id, replacedIds));
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
          .where(eq(mixTracks.mixSessionId, session.id));
        let nextOrder = currentTracks.reduce(
          (maximum, track) => Math.max(maximum, track.orderIndex + 1),
          0,
        );
        const created: Array<{ asset: typeof audioAssets.$inferSelect }> = [];
        for (const output of rendered) {
          const [asset] = await tx
            .insert(audioAssets)
            .values({
              projectId,
              kind: "preview",
              storageProvider: context.storage.providerName,
              storageKey: output.storageKey,
              originalFilename: `vocal-${output.part}.wav`,
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
                vocalBreakdownPart: output.part,
                vocalBreakdownAnalysis: analysis,
                sourceStemId: vocal.stem.id,
                sourceAudioAssetId: vocal.asset.id,
                confidence: output.confidence,
                coverage: output.coverage,
                provider: output.provider,
                modelName: output.modelName,
                modelVersion: output.modelVersion,
                experimental: true,
                generatedAt: new Date().toISOString(),
              },
            })
            .returning();
          if (!asset) throw new Error("Vocal breakdown asset insert did not return a row.");
          await tx.insert(mixTracks).values({
            mixSessionId: session.id,
            stemId: null,
            audioAssetId: asset.id,
            orderIndex: nextOrder,
            startMs: 0,
            trimStartMs: 0,
            trimEndMs: 0,
            volumeDb: output.part === "melody" ? -12 : -6,
            pan: 0,
            muted: false,
            solo: false,
            settings: { enabled: true },
            fadeInMs: 0,
            fadeOutMs: 0,
          });
          nextOrder += 1;
          created.push({ asset });
        }
        return created;
      });

      await Promise.allSettled(
        replacedAssets.map((asset) => context.storage.remove(asset.storageKey)),
      );
      return reply.status(201).send({
        analysis,
        tracks: inserted.flatMap(({ asset }) => {
          const track = toTrack(asset);
          return track ? [track] : [];
        }),
      });
    } catch (error) {
      await Promise.allSettled(outputs.map((output) => context.storage.remove(output.storageKey)));
      throw error;
    }
  });
}
