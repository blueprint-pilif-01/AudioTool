import archiver from "archiver";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { instrumentDisplayNames, saveMixSchema, type InstrumentLabel } from "@audiotool/contracts";
import { audioAssets, mixSessions, mixTracks, separationJobs, stems } from "@audiotool/database";

import { notFound } from "../errors.js";
import { serializeAsset, serializeJob, serializeStem } from "./serializers.js";
import type { ApiContext } from "./types.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const stemParams = z.object({ stemId: z.string().uuid() });
const renderSchema = z.object({ format: z.enum(["wav", "mp3", "flac"]).default("wav") });

export function registerStemAndMixRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/api/projects/:projectId/stems", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const rows = await context.db
      .select({ stem: stems })
      .from(stems)
      .where(eq(stems.projectId, projectId))
      .orderBy(asc(stems.createdAt));
    return { stems: rows.map(({ stem }) => serializeStem(stem)) };
  });

  app.get("/api/stems/:stemId/download", async (request, reply) => {
    const { stemId } = stemParams.parse(request.params);
    const [row] = await context.db
      .select({ stem: stems, asset: audioAssets })
      .from(stems)
      .innerJoin(audioAssets, eq(stems.audioAssetId, audioAssets.id))
      .where(eq(stems.id, stemId))
      .limit(1);
    if (!row) throw notFound("Stem");
    const label = row.stem.canonicalLabel.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    reply
      .header("Content-Type", row.asset.mimeType)
      .header("Content-Disposition", `attachment; filename="${label}.wav"`);
    return reply.send(context.storage.createReadStream(row.asset.storageKey));
  });

  app.get("/api/projects/:projectId/stems.zip", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const rows = await context.db
      .select({ stem: stems, asset: audioAssets })
      .from(stems)
      .innerJoin(audioAssets, eq(stems.audioAssetId, audioAssets.id))
      .where(eq(stems.projectId, projectId))
      .orderBy(asc(stems.createdAt));
    if (rows.length === 0) throw notFound("Project stems");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", (error) =>
      app.log.warn({ err: error, projectId }, "Stem archive warning"),
    );
    for (const { stem, asset } of rows) {
      const name = `${String(stem.instanceIndex + 1).padStart(2, "0")}-${stem.canonicalLabel}.wav`;
      archive.file(context.storage.resolveKey(asset.storageKey), { name });
    }
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="audiotool-stems.zip"');
    void archive.finalize();
    return reply.send(archive);
  });

  app.get("/api/projects/:projectId/mix", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const [session] = await context.db
      .select()
      .from(mixSessions)
      .where(eq(mixSessions.projectId, projectId))
      .limit(1);
    if (!session) return { mix: null };
    const rows = await context.db
      .select({ track: mixTracks, stem: stems, asset: audioAssets })
      .from(mixTracks)
      .leftJoin(stems, eq(mixTracks.stemId, stems.id))
      .innerJoin(audioAssets, eq(mixTracks.audioAssetId, audioAssets.id))
      .where(eq(mixTracks.mixSessionId, session.id))
      .orderBy(asc(mixTracks.orderIndex));
    return {
      mix: {
        id: session.id,
        projectId,
        name: session.name,
        masterSettings: session.masterSettings,
        tracks: rows.map(({ track, stem, asset }) => {
          const generatedType =
            asset.metadata.generatedTrackType === "guide" ||
            asset.metadata.generatedTrackType === "click"
              ? asset.metadata.generatedTrackType
              : null;
          const vocalPart =
            typeof asset.metadata.vocalBreakdownPart === "string" &&
            ["melody", "soprano", "alto", "tenor", "bass"].includes(
              asset.metadata.vocalBreakdownPart,
            )
              ? asset.metadata.vocalBreakdownPart
              : null;
          return {
            ...track,
            volumeDb: track.volumeDb,
            pan: track.pan,
            enabled: track.settings.enabled !== false,
            trackType: stem ? "stem" : vocalPart ? "vocal_breakdown" : (generatedType ?? "audio"),
            ...(vocalPart ? { vocalPart } : {}),
            label: stem
              ? (instrumentDisplayNames[stem.canonicalLabel as InstrumentLabel] ??
                stem.canonicalLabel)
              : generatedType === "guide"
                ? "Guide cues"
                : generatedType === "click"
                  ? "Click track"
                  : vocalPart === "melody"
                    ? "Melody guide"
                    : vocalPart
                      ? `${vocalPart[0]?.toUpperCase()}${vocalPart.slice(1)} focus`
                      : "Audio track",
            durationMs: asset.durationMs,
            streamUrl: `/api/audio/${track.audioAssetId}/stream`,
          };
        }),
      },
    };
  });

  app.put("/api/projects/:projectId/mix", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const body = saveMixSchema.parse(request.body);
    const result = await context.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(mixSessions)
        .values({ projectId, name: body.name, masterSettings: body.masterSettings })
        .onConflictDoUpdate({
          target: [mixSessions.projectId, mixSessions.name],
          set: { masterSettings: body.masterSettings, updatedAt: new Date() },
        })
        .returning();
      if (!session) throw new Error("Mix session insert did not return a row.");
      await tx.delete(mixTracks).where(eq(mixTracks.mixSessionId, session.id));
      if (body.tracks.length > 0) {
        await tx.insert(mixTracks).values(
          body.tracks.map((track) => ({
            mixSessionId: session.id,
            stemId: track.stemId ?? null,
            audioAssetId: track.audioAssetId,
            orderIndex: track.orderIndex,
            startMs: track.startMs,
            trimStartMs: track.trimStartMs,
            trimEndMs: track.trimEndMs,
            volumeDb: track.volumeDb,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
            settings: { enabled: track.enabled },
            fadeInMs: track.fadeInMs,
            fadeOutMs: track.fadeOutMs,
          })),
        );
      }
      return session;
    });
    return { mix: { id: result.id, projectId, name: result.name } };
  });

  app.post("/api/projects/:projectId/render", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = renderSchema.parse(request.body ?? {});
    const [job] = await context.db
      .insert(separationJobs)
      .values({
        projectId,
        mode: "auto",
        status: "queued",
        progress: 0,
        currentStage: "queued",
        provider: "ffmpeg",
        options: { task: "render", format: body.format },
      })
      .returning();
    if (!job) throw new Error("Render job insert did not return a row.");
    await context.jobProcessor.enqueue(job.id);
    return reply.status(202).send({ job: serializeJob(job) });
  });

  app.get("/api/projects/:projectId/exports", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const rows = await context.db
      .select()
      .from(audioAssets)
      .where(and(eq(audioAssets.projectId, projectId), eq(audioAssets.kind, "export")))
      .orderBy(desc(audioAssets.createdAt));
    return { exports: rows.map(serializeAsset) };
  });
}
