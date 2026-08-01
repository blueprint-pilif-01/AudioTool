import type {
  ApiAudioAsset,
  ApiJob,
  ApiProject,
  ApiStem,
  InstrumentLabel,
} from "@audiotool/contracts";
import { instrumentDisplayNames } from "@audiotool/contracts";
import type { AudioAssetRow, ProjectRow, SeparationJobRow, StemRow } from "@audiotool/database";

export function serializeProject(project: ProjectRow): ApiProject {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    sourceAudioId: project.sourceAudioId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function serializeAsset(asset: AudioAssetRow): ApiAudioAsset {
  return {
    id: asset.id,
    projectId: asset.projectId,
    kind: asset.kind,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    durationMs: asset.durationMs,
    sampleRate: asset.sampleRate,
    channels: asset.channels,
    codec: asset.codec,
    streamUrl: `/api/audio/${asset.id}/stream`,
  };
}

export function serializeJob(job: SeparationJobRow): ApiJob {
  return {
    id: job.id,
    projectId: job.projectId,
    mode: job.mode,
    status: job.status,
    progress: job.progress,
    currentStage: job.currentStage,
    provider: job.provider,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function serializeStem(stem: StemRow, displayLabel?: string): ApiStem {
  const canonicalLabel = stem.canonicalLabel as InstrumentLabel;
  return {
    id: stem.id,
    projectId: stem.projectId,
    jobId: stem.jobId,
    audioAssetId: stem.audioAssetId,
    canonicalLabel,
    displayLabel: displayLabel ?? instrumentDisplayNames[canonicalLabel] ?? stem.canonicalLabel,
    confidence: stem.confidence,
    isResidual: stem.isResidual,
    streamUrl: `/api/audio/${stem.audioAssetId}/stream`,
    downloadUrl: `/api/stems/${stem.id}/download`,
  };
}
