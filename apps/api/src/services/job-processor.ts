import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import {
  buildMixRenderArgs,
  measureReconstructionErrorDb,
  probeAudio,
  runProcess,
  type AudioExportFormat,
} from "@audiotool/audio-engine";
import {
  instrumentDisplayNames,
  instrumentLabelSchema,
  type InstrumentLabel,
  type JobEventPayload,
  type JobStatus,
  type SeparationMode,
} from "@audiotool/contracts";
import {
  audioAssets,
  instrumentDetections,
  mixSessions,
  mixTracks,
  processingEvents,
  projects,
  separationJobs,
  stems,
  type AudioToolDatabase,
} from "@audiotool/database";

import { AppError, notFound } from "../errors.js";
import type { JobEventHub } from "./event-hub.js";
import { assertJobTransition, canCancelJob, isTerminalJobStatus } from "./job-state.js";
import type { MlProvider } from "./ml-provider.js";
import type { AudioStorageService } from "./storage.js";

interface ProcessorOptions {
  db: AudioToolDatabase;
  storage: AudioStorageService;
  provider: MlProvider;
  eventHub: JobEventHub;
  ffmpegPath: string;
  ffprobePath: string;
  onError: (error: unknown, jobId: string) => void;
}

interface TargetStem {
  canonicalLabel: InstrumentLabel;
  displayLabel: string;
  confidence: number | null;
  detectionId: string | null;
  isResidual: boolean;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class JobProcessor {
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly options: ProcessorOptions) {}

  public enqueue(jobId: string): void {
    setImmediate(() => {
      void this.run(jobId).catch((error: unknown) => {
        this.options.onError(error, jobId);
      });
    });
  }

  public async process(jobId: string): Promise<void> {
    await this.run(jobId);
  }

  public async cancel(jobId: string): Promise<void> {
    const [current] = await this.options.db
      .select({ status: separationJobs.status, progress: separationJobs.progress })
      .from(separationJobs)
      .where(eq(separationJobs.id, jobId))
      .limit(1);
    if (!current) throw notFound("Job");
    if (current.status === "cancelled") return;
    if (!canCancelJob(current.status)) {
      throw new AppError(
        409,
        "JOB_NOT_CANCELLABLE",
        `A ${current.status} job cannot be cancelled.`,
      );
    }
    assertJobTransition(current.status, "cancelled", current.progress, current.progress);
    this.controllers.get(jobId)?.abort();
    const now = new Date();
    const updated = await this.options.db
      .update(separationJobs)
      .set({
        status: "cancelled",
        currentStage: "cancelled",
        cancelledAt: now,
        finishedAt: now,
      })
      .where(and(eq(separationJobs.id, jobId), eq(separationJobs.status, current.status)))
      .returning({ id: separationJobs.id, progress: separationJobs.progress });
    if (!updated[0]) {
      throw new AppError(409, "JOB_STATE_CHANGED", "The job state changed before cancellation.");
    }
    await this.recordEvent(jobId, "cancelled", updated[0].progress, "cancelled", "Job cancelled.");
  }

  private async run(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      const [job] = await this.options.db
        .select()
        .from(separationJobs)
        .where(eq(separationJobs.id, jobId))
        .limit(1);
      if (!job) throw notFound("Job");
      if (job.status === "cancelled") return;
      const task = job.options.task;
      if (task === "detect") await this.processDetection(jobId, job.projectId, controller.signal);
      else if (task === "render") {
        await this.processRender(jobId, job.projectId, job.options, controller.signal);
      } else
        await this.processSeparation(
          jobId,
          job.projectId,
          job.mode,
          job.options,
          controller.signal,
        );
    } catch (error) {
      const [current] = await this.options.db
        .select({ status: separationJobs.status })
        .from(separationJobs)
        .where(eq(separationJobs.id, jobId))
        .limit(1);
      if (current && !isTerminalJobStatus(current.status)) {
        const message = error instanceof Error ? error.message : "Unknown processing failure";
        await this.options.db
          .update(separationJobs)
          .set({
            status: "failed",
            currentStage: "failed",
            errorCode: error instanceof AppError ? error.code : "PROCESSING_FAILED",
            errorMessage: message,
            finishedAt: new Date(),
          })
          .where(eq(separationJobs.id, jobId));
        await this.recordEvent(jobId, "failed", 100, "failed", message, "error");
      }
      throw error;
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async loadSource(projectId: string) {
    const [project] = await this.options.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw notFound("Project");
    if (!project.sourceAudioId) {
      throw new AppError(409, "SOURCE_AUDIO_REQUIRED", "Upload a source audio file first.");
    }
    const [source] = await this.options.db
      .select()
      .from(audioAssets)
      .where(eq(audioAssets.id, project.sourceAudioId))
      .limit(1);
    if (!source) throw notFound("Source audio");
    return { project, source, path: this.options.storage.resolveKey(source.storageKey) };
  }

  private async cleanupFailedStemArtifacts(projectId: string): Promise<void> {
    const failedRows = await this.options.db
      .select({
        stemId: stems.id,
        audioAssetId: audioAssets.id,
        storageKey: audioAssets.storageKey,
      })
      .from(stems)
      .innerJoin(separationJobs, eq(stems.jobId, separationJobs.id))
      .innerJoin(audioAssets, eq(stems.audioAssetId, audioAssets.id))
      .where(
        and(
          eq(stems.projectId, projectId),
          inArray(separationJobs.status, ["failed", "cancelled"]),
        ),
      );
    if (!failedRows.length) return;
    const stemIds = failedRows.map((row) => row.stemId);
    const assetIds = failedRows.map((row) => row.audioAssetId);
    await this.options.db.transaction(async (tx) => {
      await tx.delete(mixTracks).where(inArray(mixTracks.stemId, stemIds));
      await tx.delete(stems).where(inArray(stems.id, stemIds));
      await tx.delete(audioAssets).where(inArray(audioAssets.id, assetIds));
    });
    await Promise.allSettled(failedRows.map((row) => this.options.storage.remove(row.storageKey)));
  }

  private async processDetection(
    jobId: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.setProgress(jobId, "detecting", 10, "preparing", "Preparing audio analysis.");
    const { source, path } = await this.loadSource(projectId);
    if (signal.aborted) return;

    await this.options.db
      .update(projects)
      .set({ status: "analyzing", updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await this.setProgress(jobId, "detecting", 35, "detecting", "Detecting instrument categories.");

    const detections = await this.options.provider.detectInstruments({
      audioPath: path,
      checksum: source.checksumSha256,
      durationMs: source.durationMs,
      signal,
    });
    if (signal.aborted) return;

    await this.options.db.transaction(async (tx) => {
      await tx.delete(instrumentDetections).where(eq(instrumentDetections.projectId, projectId));
      if (detections.length > 0) {
        await tx.insert(instrumentDetections).values(
          detections.map((detection) => ({
            projectId,
            canonicalLabel: detection.canonicalLabel,
            displayLabel: detection.displayLabel,
            confidence: detection.confidence,
            detectedSpans: detection.detectedSpans,
            selected: detection.selected,
            manuallyAdded: detection.manuallyAdded,
            modelName: detection.modelName,
            modelVersion: detection.modelVersion,
          })),
        );
      }
      await tx
        .update(projects)
        .set({ status: "awaiting_confirmation", updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await tx
        .update(separationJobs)
        .set({
          status: "awaiting_confirmation",
          progress: 100,
          currentStage: "awaiting_confirmation",
          modelName: detections[0]?.modelName ?? this.options.provider.modelName,
          modelVersion: detections[0]?.modelVersion ?? this.options.provider.modelVersion,
          finishedAt: new Date(),
        })
        .where(eq(separationJobs.id, jobId));
    });
    await this.recordEvent(
      jobId,
      "awaiting_confirmation",
      100,
      "awaiting_confirmation",
      `Detected ${detections.length} instrument categories. Confirm the selection to continue.`,
    );
  }

  private async resolveTargets(
    projectId: string,
    mode: SeparationMode,
    rawDetectionIds: unknown,
    rawCanonicalLabels: unknown,
    ensureResidual: boolean,
  ): Promise<TargetStem[]> {
    const canonicalLabels = Array.isArray(rawCanonicalLabels)
      ? rawCanonicalLabels.flatMap((label) => {
          const parsed = instrumentLabelSchema.safeParse(label);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    if (mode === "quick") {
      const targets: TargetStem[] = [
        {
          canonicalLabel: "vocals",
          displayLabel: instrumentDisplayNames.vocals,
          confidence: null,
          detectionId: null,
          isResidual: false,
        },
        {
          canonicalLabel: "instrumental",
          displayLabel: instrumentDisplayNames.instrumental,
          confidence: null,
          detectionId: null,
          isResidual: true,
        },
      ];
      const filtered =
        canonicalLabels.length > 0
          ? targets.filter((target) => canonicalLabels.includes(target.canonicalLabel))
          : targets;
      if (filtered.length === 0) {
        throw new AppError(409, "NO_RETRY_TARGETS", "No requested quick-separation target exists.");
      }
      return filtered;
    }

    if (mode === "standard") {
      const targets = (["vocals", "drums", "bass_guitar", "other"] as const).map(
        (canonicalLabel) => ({
          canonicalLabel,
          displayLabel: instrumentDisplayNames[canonicalLabel],
          confidence: null,
          detectionId: null,
          isResidual: canonicalLabel === "other",
        }),
      );
      const filtered =
        canonicalLabels.length > 0
          ? targets.filter((target) => canonicalLabels.includes(target.canonicalLabel))
          : targets;
      if (filtered.length === 0) {
        throw new AppError(409, "NO_RETRY_TARGETS", "No requested standard target exists.");
      }
      return filtered;
    }

    const detectionIds = Array.isArray(rawDetectionIds)
      ? rawDetectionIds.filter((id): id is string => typeof id === "string")
      : [];
    const conditions = [
      eq(instrumentDetections.projectId, projectId),
      eq(instrumentDetections.selected, true),
    ];
    if (detectionIds.length > 0) conditions.push(inArray(instrumentDetections.id, detectionIds));
    const selected =
      detectionIds.length === 0 && canonicalLabels.length > 0
        ? []
        : await this.options.db
            .select()
            .from(instrumentDetections)
            .where(and(...conditions))
            .orderBy(asc(instrumentDetections.createdAt));
    if (selected.length === 0 && canonicalLabels.length === 0) {
      throw new AppError(409, "NO_INSTRUMENTS_SELECTED", "Select at least one instrument.");
    }

    const uniqueSelected = [
      ...new Map(selected.map((item) => [item.canonicalLabel, item])).values(),
    ];
    let targets: TargetStem[] = uniqueSelected.map((detection) => ({
      canonicalLabel: detection.canonicalLabel as InstrumentLabel,
      displayLabel: detection.displayLabel,
      confidence: detection.confidence,
      detectionId: detection.id,
      isResidual: false,
    }));
    for (const canonicalLabel of canonicalLabels) {
      if (targets.some((target) => target.canonicalLabel === canonicalLabel)) continue;
      targets.push({
        canonicalLabel,
        displayLabel: instrumentDisplayNames[canonicalLabel],
        confidence: null,
        detectionId: null,
        isResidual: canonicalLabel === "other",
      });
    }
    const textureLabels = ["synthesizer", "percussion"] as const;
    const usesComplementaryTextureSplit = uniqueSelected.some(
      (detection) =>
        detection.modelName === "residual-texture-split" &&
        textureLabels.includes(detection.canonicalLabel as (typeof textureLabels)[number]),
    );
    if (usesComplementaryTextureSplit) {
      for (const canonicalLabel of textureLabels) {
        if (targets.some((target) => target.canonicalLabel === canonicalLabel)) continue;
        targets.push({
          canonicalLabel,
          displayLabel: instrumentDisplayNames[canonicalLabel],
          confidence: null,
          detectionId: null,
          isResidual: false,
        });
      }
      targets = targets.filter((target) => target.canonicalLabel !== "other");
    }
    if (
      ensureResidual &&
      !usesComplementaryTextureSplit &&
      !targets.some((target) => target.canonicalLabel === "other")
    ) {
      targets.push({
        canonicalLabel: "other",
        displayLabel: instrumentDisplayNames.other,
        confidence: null,
        detectionId: null,
        isResidual: true,
      });
    }
    return targets;
  }

  private async processSeparation(
    jobId: string,
    projectId: string,
    mode: SeparationMode,
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const { source, path } = await this.loadSource(projectId);
    await this.cleanupFailedStemArtifacts(projectId);
    const partialRetry = options.partialRetry === true;
    const targets = await this.resolveTargets(
      projectId,
      mode,
      options.detectionIds,
      options.canonicalLabels,
      !partialRetry,
    );
    await this.options.db
      .update(projects)
      .set({ status: "separating", updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await this.setProgress(jobId, "separating", 5, "preparing", "Preparing stem separation.");

    const createdStems: Array<{
      stemId: string;
      audioAssetId: string;
      durationMs: number;
      canonicalLabel: InstrumentLabel;
      absolutePath: string;
      provider: string;
      modelName: string;
      modelVersion: string;
    }> = [];
    for (const [index, target] of targets.entries()) {
      if (signal.aborted) return;
      const progress = 10 + Math.round((index / targets.length) * 75);
      await this.setProgress(
        jobId,
        "separating",
        progress,
        `separating_${target.canonicalLabel}`,
        `Creating ${target.displayLabel} stem.`,
      );
      const output = await this.options.storage.createOutputPath(
        projectId,
        target.canonicalLabel,
        ".wav",
      );
      const targetStartedAt = performance.now();
      let separationResult: Awaited<ReturnType<MlProvider["separateStem"]>>;
      try {
        separationResult = await this.options.provider.separateStem({
          audioPath: path,
          checksum: source.checksumSha256,
          targetLabel: target.canonicalLabel,
          outputPath: output.absolutePath,
          separationMode: mode,
          signal,
        });
      } catch (error) {
        await this.options.storage.remove(output.storageKey);
        await this.options.db
          .update(separationJobs)
          .set({
            options: {
              ...options,
              failedTarget: {
                canonicalLabel: target.canonicalLabel,
                detectionId: target.detectionId,
              },
            },
          })
          .where(eq(separationJobs.id, jobId));
        throw error;
      }
      const [metadata, checksum, fileStats] = await Promise.all([
        probeAudio(output.absolutePath, this.options.ffprobePath),
        sha256File(output.absolutePath),
        stat(output.absolutePath),
      ]);
      const [asset] = await this.options.db
        .insert(audioAssets)
        .values({
          projectId,
          kind: "stem",
          storageProvider: this.options.storage.providerName,
          storageKey: output.storageKey,
          originalFilename: `${target.canonicalLabel}.wav`,
          mimeType: "audio/wav",
          extension: ".wav",
          sizeBytes: fileStats.size,
          checksumSha256: checksum,
          durationMs: metadata.durationMs,
          sampleRate: metadata.sampleRate,
          channels: metadata.channels,
          codec: metadata.codec,
          bitrate: metadata.bitrate,
          metadata: {
            mock: separationResult.provider === "mock",
            sourceAudioId: source.id,
          },
        })
        .returning({ id: audioAssets.id });
      if (!asset) throw new Error("Audio asset insert did not return an id.");
      const [stem] = await this.options.db
        .insert(stems)
        .values({
          projectId,
          jobId,
          audioAssetId: asset.id,
          instrumentDetectionId: target.detectionId,
          canonicalLabel: target.canonicalLabel,
          confidence: target.confidence,
          isResidual: target.isResidual,
          instanceIndex: 0,
          processingMetadata: {
            provider: separationResult.provider,
            modelName: separationResult.modelName,
            modelVersion: separationResult.modelVersion,
            query: target.canonicalLabel,
            elapsedMs: Math.round(performance.now() - targetStartedAt),
            mock: separationResult.provider === "mock",
          },
        })
        .returning({ id: stems.id });
      if (!stem) throw new Error("Stem insert did not return an id.");
      createdStems.push({
        stemId: stem.id,
        audioAssetId: asset.id,
        durationMs: metadata.durationMs,
        canonicalLabel: target.canonicalLabel,
        absolutePath: output.absolutePath,
        provider: separationResult.provider,
        modelName: separationResult.modelName,
        modelVersion: separationResult.modelVersion,
      });
    }

    if (signal.aborted) return;
    let reconstructionCheck: Record<string, unknown>;
    if (partialRetry) {
      reconstructionCheck = {
        evaluated: false,
        reason: "Partial retry preserves the previous full-job reconstruction measurement.",
      };
    } else {
      try {
        const errorRmsDb = await measureReconstructionErrorDb(
          path,
          createdStems.map((stem) => stem.absolutePath),
          this.options.ffmpegPath,
          signal,
        );
        reconstructionCheck = {
          evaluated: true,
          errorRmsDb,
          thresholdDb: -30,
          passed: errorRmsDb <= -30,
        };
        if (errorRmsDb > -30) {
          await this.recordEvent(
            jobId,
            "separating",
            85,
            "reconstruction_check",
            `Stem reconstruction error is ${errorRmsDb.toFixed(1)} dB; review the residual and provider output.`,
            "warning",
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        reconstructionCheck = {
          evaluated: false,
          error: error instanceof Error ? error.message : "Reconstruction check unavailable",
        };
        await this.recordEvent(
          jobId,
          "separating",
          85,
          "reconstruction_check",
          "Stem reconstruction could not be measured; the output remains available for review.",
          "warning",
        );
      }
    }

    await this.setProgress(
      jobId,
      "rendering",
      90,
      "creating_mixer",
      "Creating the multitrack session.",
    );
    let mixerStems: Array<{ stemId: string; audioAssetId: string }> = createdStems;
    if (partialRetry) {
      const available = await this.options.db
        .select({
          stemId: stems.id,
          audioAssetId: stems.audioAssetId,
          canonicalLabel: stems.canonicalLabel,
        })
        .from(stems)
        .where(eq(stems.projectId, projectId))
        .orderBy(asc(stems.createdAt));
      const latestByLabel = new Map<string, { stemId: string; audioAssetId: string }>();
      for (const stem of available) {
        latestByLabel.set(stem.canonicalLabel, {
          stemId: stem.stemId,
          audioAssetId: stem.audioAssetId,
        });
      }
      mixerStems = [...latestByLabel.values()];
    }
    await this.options.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(mixSessions)
        .values({ projectId, name: "Main mix", masterSettings: { volumeDb: 0 } })
        .onConflictDoUpdate({
          target: [mixSessions.projectId, mixSessions.name],
          set: { updatedAt: new Date() },
        })
        .returning({ id: mixSessions.id });
      if (!session) throw new Error("Mix session insert did not return an id.");
      const generatedTracks = await tx
        .select({ track: mixTracks, asset: audioAssets })
        .from(mixTracks)
        .innerJoin(audioAssets, eq(mixTracks.audioAssetId, audioAssets.id))
        .where(eq(mixTracks.mixSessionId, session.id))
        .orderBy(asc(mixTracks.orderIndex));
      const preservedTracks = generatedTracks.filter(
        ({ asset }) =>
          asset.metadata.generatedTrackType === "guide" ||
          asset.metadata.generatedTrackType === "click" ||
          (typeof asset.metadata.vocalBreakdownPart === "string" &&
            ["melody", "soprano", "alto", "tenor", "bass"].includes(
              asset.metadata.vocalBreakdownPart,
            )),
      );
      await tx.delete(mixTracks).where(eq(mixTracks.mixSessionId, session.id));
      if (mixerStems.length > 0 || preservedTracks.length > 0) {
        await tx.insert(mixTracks).values([
          ...mixerStems.map((created, index) => ({
            mixSessionId: session.id,
            stemId: created.stemId,
            audioAssetId: created.audioAssetId,
            orderIndex: index,
            startMs: 0,
            trimStartMs: 0,
            trimEndMs: 0,
            volumeDb: 0,
            pan: 0,
            muted: false,
            solo: false,
            settings: { enabled: true },
            fadeInMs: 0,
            fadeOutMs: 0,
          })),
          ...preservedTracks.map(({ track }, index) => ({
            mixSessionId: session.id,
            stemId: null,
            audioAssetId: track.audioAssetId,
            orderIndex: mixerStems.length + index,
            startMs: track.startMs,
            trimStartMs: track.trimStartMs,
            trimEndMs: track.trimEndMs,
            volumeDb: track.volumeDb,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
            settings: track.settings,
            fadeInMs: track.fadeInMs,
            fadeOutMs: track.fadeOutMs,
          })),
        ]);
      }
      await tx
        .update(projects)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await tx
        .update(separationJobs)
        .set({
          status: "completed",
          progress: 100,
          currentStage: "completed",
          modelName: createdStems[0]?.modelName ?? this.options.provider.modelName,
          modelVersion: createdStems[0]?.modelVersion ?? this.options.provider.modelVersion,
          finishedAt: new Date(),
          options: {
            ...options,
            failedTarget: null,
            reconstructionCheck,
          },
        })
        .where(eq(separationJobs.id, jobId));
    });
    await this.recordEvent(
      jobId,
      "completed",
      100,
      "completed",
      `Created ${createdStems.length} stems and opened the mixer.`,
    );
  }

  private async processRender(
    jobId: string,
    projectId: string,
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const format: AudioExportFormat =
      options.format === "mp3" || options.format === "flac" ? options.format : "wav";
    await this.setProgress(
      jobId,
      "rendering",
      5,
      "preparing_mix",
      "Preparing the saved mix session.",
    );
    const [session] = await this.options.db
      .select()
      .from(mixSessions)
      .where(eq(mixSessions.projectId, projectId))
      .orderBy(asc(mixSessions.createdAt))
      .limit(1);
    if (!session)
      throw new AppError(409, "MIX_SESSION_REQUIRED", "Save a mix session before rendering.");
    const rows = await this.options.db
      .select({ track: mixTracks, asset: audioAssets })
      .from(mixTracks)
      .innerJoin(audioAssets, eq(mixTracks.audioAssetId, audioAssets.id))
      .where(eq(mixTracks.mixSessionId, session.id))
      .orderBy(asc(mixTracks.orderIndex));
    if (rows.length === 0)
      throw new AppError(409, "MIX_TRACKS_REQUIRED", "The mix has no audio tracks.");
    const activeRows = rows.filter(({ track }) => track.settings.enabled !== false);
    if (activeRows.length === 0) {
      throw new AppError(409, "MIX_TRACKS_REQUIRED", "The mix has no enabled audio tracks.");
    }
    const hasSolo = activeRows.some(({ track }) => track.solo);
    const output = await this.options.storage.createOutputPath(
      projectId,
      "rendered-mix",
      `.${format}`,
    );
    try {
      await this.setProgress(
        jobId,
        "rendering",
        25,
        "rendering_mix",
        "Rendering tracks with FFmpeg.",
      );
      const args = buildMixRenderArgs(
        activeRows.map(({ track, asset }) => ({
          inputPath: this.options.storage.resolveKey(asset.storageKey),
          startMs: track.startMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
          durationMs: asset.durationMs,
          volumeDb: track.volumeDb,
          pan: track.pan,
          muted: track.muted || (hasSolo && !track.solo),
          fadeInMs: track.fadeInMs,
          fadeOutMs: track.fadeOutMs,
        })),
        output.absolutePath,
        session.masterSettings.volumeDb,
        format,
      );
      await runProcess(this.options.ffmpegPath, args, {
        timeoutMs: 600_000,
        signal,
      });
      if (signal.aborted) {
        await this.options.storage.remove(output.storageKey);
        return;
      }
      await this.setProgress(
        jobId,
        "rendering",
        85,
        "saving_export",
        "Saving the rendered audio asset.",
      );
      const [metadata, checksum, fileStats] = await Promise.all([
        probeAudio(output.absolutePath, this.options.ffprobePath),
        sha256File(output.absolutePath),
        stat(output.absolutePath),
      ]);
      const [asset] = await this.options.db
        .insert(audioAssets)
        .values({
          projectId,
          kind: "export",
          storageProvider: this.options.storage.providerName,
          storageKey: output.storageKey,
          originalFilename: `${session.name.replaceAll(/[^a-zA-Z0-9_-]+/g, "-") || "mix"}.${format}`,
          mimeType:
            format === "mp3" ? "audio/mpeg" : format === "flac" ? "audio/flac" : "audio/wav",
          extension: `.${format}`,
          sizeBytes: fileStats.size,
          checksumSha256: checksum,
          durationMs: metadata.durationMs,
          sampleRate: metadata.sampleRate,
          channels: metadata.channels,
          codec: metadata.codec,
          bitrate: metadata.bitrate,
          metadata: { mixSessionId: session.id, jobId, format },
        })
        .returning({ id: audioAssets.id });
      if (!asset) throw new Error("Rendered asset insert did not return an id.");
      await this.options.db
        .update(separationJobs)
        .set({
          status: "completed",
          progress: 100,
          currentStage: "completed",
          finishedAt: new Date(),
          options: { ...options, outputAudioId: asset.id },
        })
        .where(eq(separationJobs.id, jobId));
      await this.recordEvent(jobId, "completed", 100, "completed", "Mix render completed.");
    } catch (error) {
      await this.options.storage.remove(output.storageKey);
      throw error;
    }
  }

  private async setProgress(
    jobId: string,
    status: JobStatus,
    progress: number,
    stage: string,
    message: string,
  ): Promise<void> {
    const [current] = await this.options.db
      .select({
        status: separationJobs.status,
        progress: separationJobs.progress,
        startedAt: separationJobs.startedAt,
      })
      .from(separationJobs)
      .where(eq(separationJobs.id, jobId))
      .limit(1);
    if (!current) throw notFound("Job");
    assertJobTransition(current.status, status, current.progress, progress);
    await this.options.db
      .update(separationJobs)
      .set({
        status,
        progress,
        currentStage: stage,
        startedAt: current.startedAt ?? new Date(),
      })
      .where(eq(separationJobs.id, jobId));
    await this.recordEvent(jobId, status, progress, stage, message);
  }

  private async recordEvent(
    jobId: string,
    status: JobStatus,
    progress: number,
    stage: string,
    message: string,
    level: "debug" | "info" | "warning" | "error" = "info",
  ): Promise<void> {
    const timestamp = new Date();
    await this.options.db.insert(processingEvents).values({
      jobId,
      level,
      eventType: stage,
      message,
      data: { status, progress },
      createdAt: timestamp,
    });
    const event: JobEventPayload = {
      jobId,
      status,
      progress,
      stage,
      message,
      timestamp: timestamp.toISOString(),
    };
    this.options.eventHub.publish(event);
  }
}
