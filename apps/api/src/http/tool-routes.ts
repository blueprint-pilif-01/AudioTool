import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  analyzeKeyBpm,
  buildAdvancedJoinerArgs,
  buildRegionCutterArgs,
  FfmpegPitchTempoAdapter,
  probeAudio,
  runProcess,
  type AudioExportFormat,
} from "@audiotool/audio-engine";

import { AppError } from "../errors.js";
import type { ApiContext } from "./types.js";

interface ToolUpload {
  storageKey: string;
  absolutePath: string;
  originalFilename: string;
}

interface ToolMultipart {
  uploads: ToolUpload[];
  fields: Record<string, string>;
  cleanup: () => Promise<void>;
}

async function collectToolMultipart(
  request: FastifyRequest,
  context: ApiContext,
  maxFiles: number,
): Promise<ToolMultipart> {
  const namespace = randomUUID();
  const uploads: ToolUpload[] = [];
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (uploads.length >= maxFiles) {
          part.file.resume();
          throw new AppError(400, "TOO_MANY_FILES", `Upload no more than ${maxFiles} audio files.`);
        }
        const stored = await context.storage.storeUpload(
          namespace,
          part.filename,
          part.mimetype,
          part.file,
        );
        uploads.push({
          storageKey: stored.storageKey,
          absolutePath: stored.absolutePath,
          originalFilename: stored.originalFilename,
        });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    await Promise.all(uploads.map((upload) => context.storage.remove(upload.storageKey)));
    throw error;
  }
  return {
    uploads,
    fields,
    cleanup: async () => {
      await Promise.all(uploads.map((upload) => context.storage.remove(upload.storageKey)));
    },
  };
}

function requireOneUpload(multipart: ToolMultipart): ToolUpload {
  const upload = multipart.uploads[0];
  if (!upload) throw new AppError(400, "AUDIO_FILE_REQUIRED", "Select an audio file first.");
  return upload;
}

function removeOutputAfterResponse(
  app: FastifyInstance,
  replyRaw: NodeJS.EventEmitter,
  context: ApiContext,
  storageKey: string,
) {
  replyRaw.once("finish", () => {
    void context.storage.remove(storageKey).catch((error: unknown) => {
      app.log.warn({ err: error, storageKey }, "Could not remove temporary tool output");
    });
  });
}

const pitchTempoFields = z.object({
  pitchSemitones: z.coerce.number().min(-12).max(12),
  tempoPercent: z.coerce.number().min(50).max(200),
});

const cutterFields = z.object({
  regions: z.string(),
  operation: z.enum(["keep", "remove"]).default("keep"),
  format: z.enum(["wav", "mp3", "flac"]).default("wav"),
  fadeInMs: z.coerce.number().int().nonnegative().default(0),
  fadeOutMs: z.coerce.number().int().nonnegative().default(0),
});

const joinerFields = z.object({
  trims: z.string(),
  transition: z.enum(["none", "pause", "crossfade"]).default("none"),
  transitionMs: z.coerce.number().int().min(0).max(5000).default(0),
  normalize: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  format: z.enum(["wav", "mp3", "flac"]).default("wav"),
});

const cutterRegionsSchema = z
  .array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
    }),
  )
  .min(1)
  .max(20);

const joinerTrimsSchema = z
  .array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
    }),
  )
  .min(2)
  .max(20);

const outputFormats: Record<AudioExportFormat, { extension: `.${string}`; contentType: string }> = {
  wav: { extension: ".wav", contentType: "audio/wav" },
  mp3: { extension: ".mp3", contentType: "audio/mpeg" },
  flac: { extension: ".flac", contentType: "audio/flac" },
};

function parseJsonField<T>(value: string, schema: z.ZodType<T>, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppError(400, "INVALID_TOOL_OPTIONS", `${label} must be valid JSON.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, "INVALID_TOOL_OPTIONS", `${label} contains invalid values.`);
  }
  return result.data;
}

export function registerToolRoutes(app: FastifyInstance, context: ApiContext) {
  const pitchTempoAdapter = new FfmpegPitchTempoAdapter(context.config.FFMPEG_PATH);

  app.post("/api/tools/analyze-key-bpm", async (request) => {
    const multipart = await collectToolMultipart(request, context, 1);
    try {
      const upload = requireOneUpload(multipart);
      const startedAt = performance.now();
      const [metadata, analysis] = await Promise.all([
        probeAudio(upload.absolutePath, context.config.FFPROBE_PATH),
        analyzeKeyBpm(upload.absolutePath, context.config.FFMPEG_PATH),
      ]);
      return {
        analysis: {
          key: analysis.key,
          scale: analysis.scale,
          bpm: analysis.bpm,
          confidence: analysis.confidence,
          durationMs: metadata.durationMs,
          analyzedDurationMs: analysis.analyzedDurationMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          tempoCandidates: Array.from(
            new Set([
              analysis.bpm,
              ...(analysis.bpm < 100 ? [Math.round(analysis.bpm * 20) / 10] : []),
              ...(analysis.bpm > 140 ? [Math.round((analysis.bpm / 2) * 10) / 10] : []),
            ]),
          ),
          provider: "local-heuristic-v1",
        },
      };
    } finally {
      await multipart.cleanup();
    }
  });

  app.post("/api/tools/pitch-tempo", async (request, reply) => {
    const multipart = await collectToolMultipart(request, context, 1);
    try {
      const upload = requireOneUpload(multipart);
      const fields = pitchTempoFields.parse(multipart.fields);
      const metadata = await probeAudio(upload.absolutePath, context.config.FFPROBE_PATH);
      const output = await context.storage.createOutputPath(randomUUID(), "pitch-tempo", ".wav");
      await pitchTempoAdapter.render({
        inputPath: upload.absolutePath,
        outputPath: output.absolutePath,
        pitchSemitones: fields.pitchSemitones,
        tempoPercent: fields.tempoPercent,
        sampleRate: metadata.sampleRate ?? 44_100,
      });
      removeOutputAfterResponse(app, reply.raw, context, output.storageKey);
      reply
        .header("Content-Type", "audio/wav")
        .header("Content-Disposition", 'attachment; filename="pitch-tempo.wav"');
      return reply.send(context.storage.createReadStream(output.storageKey));
    } finally {
      await multipart.cleanup();
    }
  });

  app.post("/api/tools/cut", async (request, reply) => {
    const multipart = await collectToolMultipart(request, context, 1);
    try {
      const upload = requireOneUpload(multipart);
      const fields = cutterFields.parse(multipart.fields);
      const regions = parseJsonField(fields.regions, cutterRegionsSchema, "Cutter regions");
      const metadata = await probeAudio(upload.absolutePath, context.config.FFPROBE_PATH);
      if (regions.some((region) => region.endMs > metadata.durationMs + 10)) {
        throw new AppError(
          400,
          "CUT_RANGE_OUT_OF_BOUNDS",
          "A selected range exceeds the audio duration.",
        );
      }
      const outputFormat = outputFormats[fields.format];
      const output = await context.storage.createOutputPath(
        randomUUID(),
        "cut",
        outputFormat.extension,
      );
      let args: string[];
      try {
        args = buildRegionCutterArgs(
          upload.absolutePath,
          output.absolutePath,
          metadata.durationMs,
          regions,
          fields.operation,
          fields.fadeInMs,
          fields.fadeOutMs,
          fields.format,
        );
      } catch (cause) {
        throw new AppError(
          400,
          "INVALID_CUT_OPTIONS",
          cause instanceof Error ? cause.message : "The cutter settings are invalid.",
        );
      }
      await runProcess(context.config.FFMPEG_PATH, args, { timeoutMs: 300_000 });
      removeOutputAfterResponse(app, reply.raw, context, output.storageKey);
      reply
        .header("Content-Type", outputFormat.contentType)
        .header("Content-Disposition", `attachment; filename="audio-cut.${fields.format}"`);
      return reply.send(context.storage.createReadStream(output.storageKey));
    } finally {
      await multipart.cleanup();
    }
  });

  app.post("/api/tools/join", async (request, reply) => {
    const multipart = await collectToolMultipart(request, context, 20);
    try {
      const fields = joinerFields.parse(multipart.fields);
      if (multipart.uploads.length < 2) {
        throw new AppError(400, "JOINER_FILES_REQUIRED", "Select at least two audio files.");
      }
      const metadata = await Promise.all(
        multipart.uploads.map((upload) =>
          probeAudio(upload.absolutePath, context.config.FFPROBE_PATH),
        ),
      );
      const trims = parseJsonField(fields.trims, joinerTrimsSchema, "Joiner trims");
      if (trims.length !== multipart.uploads.length) {
        throw new AppError(
          400,
          "JOINER_TRIM_COUNT_MISMATCH",
          "Each input file must have one trim range.",
        );
      }
      if (trims.some((trim, index) => trim.endMs > metadata[index]!.durationMs + 10)) {
        throw new AppError(
          400,
          "JOINER_TRIM_OUT_OF_BOUNDS",
          "A trim range exceeds its input file duration.",
        );
      }
      const outputFormat = outputFormats[fields.format];
      const output = await context.storage.createOutputPath(
        randomUUID(),
        "joined",
        outputFormat.extension,
      );
      let args: string[];
      try {
        args = buildAdvancedJoinerArgs(
          multipart.uploads.map((upload) => upload.absolutePath),
          output.absolutePath,
          trims,
          fields.transition,
          fields.transitionMs,
          fields.normalize,
          fields.format,
        );
      } catch (cause) {
        throw new AppError(
          400,
          "INVALID_JOIN_OPTIONS",
          cause instanceof Error ? cause.message : "The joiner settings are invalid.",
        );
      }
      await runProcess(context.config.FFMPEG_PATH, args, { timeoutMs: 600_000 });
      removeOutputAfterResponse(app, reply.raw, context, output.storageKey);
      reply
        .header("Content-Type", outputFormat.contentType)
        .header("Content-Disposition", `attachment; filename="joined-audio.${fields.format}"`);
      return reply.send(context.storage.createReadStream(output.storageKey));
    } finally {
      await multipart.cleanup();
    }
  });
}
