import type {
  ApiAudioAsset,
  ApiJob,
  ApiProject,
  ApiRecentJob,
  ApiStem,
  GenerateGuideTracksInput,
  GeneratedProjectTrack,
  GuideVoice,
  InstrumentDetection,
  JobEventPayload,
  MlProviderCapabilities,
  SaveMixInput,
  SeparationMode,
  GenerateVocalBreakdownInput,
  VocalBreakdownAnalysis,
  VocalBreakdownTrack,
  VocalBreakdownPart,
} from "@audiotool/contracts";

const configuredBase = import.meta.env.DEV
  ? ""
  : (import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "");

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export type ToolAudioFormat = "wav" | "mp3" | "flac";

export interface CutterOptions {
  regions: Array<{ startMs: number; endMs: number }>;
  operation: "keep" | "remove";
  fadeInMs: number;
  fadeOutMs: number;
  format: ToolAudioFormat;
}

export interface JoinerOptions {
  trims: Array<{ startMs: number; endMs: number }>;
  transition: "none" | "pause" | "crossfade";
  transitionMs: number;
  normalize: boolean;
  format: ToolAudioFormat;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${configuredBase}${path.startsWith("/") ? path : `/${path}`}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ErrorEnvelope;
    throw new ApiError(
      payload.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBlob(path: string, body: FormData): Promise<Blob> {
  const response = await fetch(apiUrl(path), { method: "POST", body });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ErrorEnvelope;
    throw new ApiError(
      payload.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
    );
  }
  return response.blob();
}

async function requestJsonBlob(path: string, body: unknown): Promise<Blob> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ErrorEnvelope;
    throw new ApiError(
      payload.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
    );
  }
  return response.blob();
}

export type ApiMixTrack = SaveMixInput["tracks"][number] & {
  label: string;
  trackType: "stem" | "guide" | "click" | "vocal_breakdown" | "audio";
  vocalPart?: VocalBreakdownPart;
  durationMs: number;
  streamUrl: string;
};

export interface ApiMix {
  id: string;
  projectId: string;
  name: string;
  masterSettings: { volumeDb: number };
  tracks: ApiMixTrack[];
}

export const api = {
  getMlCapabilities: () =>
    request<{ capabilities: MlProviderCapabilities }>("/api/ml/capabilities"),
  listProjects: () => request<{ projects: ApiProject[] }>("/api/projects"),
  listRecentJobs: (limit = 8) =>
    request<{ jobs: ApiRecentJob[] }>(`/api/jobs?limit=${encodeURIComponent(limit)}`),
  getProject: (projectId: string) => request<{ project: ApiProject }>(`/api/projects/${projectId}`),
  createProject: (name: string) =>
    request<{ project: ApiProject }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateProject: (projectId: string, name: string) =>
    request<{ project: ApiProject }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteProject: (projectId: string) =>
    request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  uploadAudio: (projectId: string, file: File, onProgress?: (progress: number) => void) =>
    new Promise<ApiAudioAsset>((resolve, reject) => {
      const body = new FormData();
      body.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl(`/api/projects/${projectId}/audio`));
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener("load", () => {
        const payload = JSON.parse(xhr.responseText || "{}") as
          { asset: ApiAudioAsset } | ErrorEnvelope;
        if (xhr.status >= 200 && xhr.status < 300 && "asset" in payload) resolve(payload.asset);
        else {
          const error = "error" in payload ? payload.error : undefined;
          reject(
            new ApiError(
              error?.message ?? "Upload failed.",
              xhr.status,
              error?.code ?? "UPLOAD_FAILED",
            ),
          );
        }
      });
      xhr.addEventListener("error", () =>
        reject(new ApiError("Upload failed.", 0, "NETWORK_ERROR")),
      );
      xhr.send(body);
    }),
  getAudio: (assetId: string) => request<{ asset: ApiAudioAsset }>(`/api/audio/${assetId}`),
  startDetection: (projectId: string) =>
    request<{ job: ApiJob }>(`/api/projects/${projectId}/detect-instruments`, {
      method: "POST",
      body: "{}",
    }),
  getDetections: (projectId: string) =>
    request<{ detections: InstrumentDetection[] }>(`/api/projects/${projectId}/detections`),
  saveDetections: (projectId: string, detections: InstrumentDetection[]) =>
    request<{ detections: InstrumentDetection[] }>(`/api/projects/${projectId}/detections`, {
      method: "PATCH",
      body: JSON.stringify({ detections }),
    }),
  startSeparation: (projectId: string, mode: SeparationMode, detectionIds?: string[]) =>
    request<{ job: ApiJob }>(`/api/projects/${projectId}/separation-jobs`, {
      method: "POST",
      body: JSON.stringify({ mode, ...(detectionIds ? { detectionIds } : {}) }),
    }),
  listJobs: (projectId: string) => request<{ jobs: ApiJob[] }>(`/api/projects/${projectId}/jobs`),
  getJob: (jobId: string) => request<{ job: ApiJob }>(`/api/jobs/${jobId}`),
  cancelJob: (jobId: string) =>
    request<{ accepted: boolean }>(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  retryJob: (jobId: string) =>
    request<{ job: ApiJob }>(`/api/jobs/${jobId}/retry`, { method: "POST", body: "{}" }),
  getStems: (projectId: string) =>
    request<{ stems: ApiStem[] }>(`/api/projects/${projectId}/stems`),
  getExports: (projectId: string) =>
    request<{ exports: ApiAudioAsset[] }>(`/api/projects/${projectId}/exports`),
  getMix: (projectId: string) => request<{ mix: ApiMix | null }>(`/api/projects/${projectId}/mix`),
  getGuideTracks: (projectId: string) =>
    request<{
      durationMs: number;
      cloudTtsConfigured: boolean;
      neuralTtsAvailable: boolean;
      voices: GuideVoice[];
      tracks: GeneratedProjectTrack[];
    }>(`/api/projects/${projectId}/guide-tracks`),
  generateGuideTracks: (projectId: string, input: GenerateGuideTracksInput) =>
    request<{ tracks: GeneratedProjectTrack[] }>(`/api/projects/${projectId}/guide-tracks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  previewGuideVoice: (
    projectId: string,
    input: { voiceName: string; text: string; speechRate: number },
  ) => requestJsonBlob(`/api/projects/${projectId}/guide-voice-preview`, input),
  getVocalBreakdown: (projectId: string) =>
    request<{
      vocalStem: ApiStem;
      durationMs: number;
      analysis: VocalBreakdownAnalysis | null;
      tracks: VocalBreakdownTrack[];
    }>(`/api/projects/${projectId}/vocal-breakdown`),
  generateVocalBreakdown: (projectId: string, input: GenerateVocalBreakdownInput) =>
    request<{ analysis: VocalBreakdownAnalysis; tracks: VocalBreakdownTrack[] }>(
      `/api/projects/${projectId}/vocal-breakdown`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  saveMix: (projectId: string, mix: SaveMixInput) =>
    request<{ mix: { id: string; projectId: string; name: string } }>(
      `/api/projects/${projectId}/mix`,
      { method: "PUT", body: JSON.stringify(mix) },
    ),
  renderMix: (projectId: string, format: ToolAudioFormat = "wav") =>
    request<{ job: ApiJob }>(`/api/projects/${projectId}/render`, {
      method: "POST",
      body: JSON.stringify({ format }),
    }),
  analyzeKeyBpm: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<{
      analysis: {
        key: string;
        scale: "major" | "minor";
        bpm: number;
        confidence: number;
        durationMs: number;
        analyzedDurationMs: number;
        elapsedMs: number;
        tempoCandidates: number[];
        provider: string;
      };
    }>("/api/tools/analyze-key-bpm", { method: "POST", body });
  },
  processPitchTempo: (file: File, pitchSemitones: number, tempoPercent: number) => {
    const body = new FormData();
    body.append("file", file);
    body.append("pitchSemitones", String(pitchSemitones));
    body.append("tempoPercent", String(tempoPercent));
    return requestBlob("/api/tools/pitch-tempo", body);
  },
  cutAudio: (file: File, options: CutterOptions) => {
    const body = new FormData();
    body.append("file", file);
    body.append("regions", JSON.stringify(options.regions));
    body.append("operation", options.operation);
    body.append("fadeInMs", String(options.fadeInMs));
    body.append("fadeOutMs", String(options.fadeOutMs));
    body.append("format", options.format);
    return requestBlob("/api/tools/cut", body);
  },
  joinAudio: (files: File[], options: JoinerOptions) => {
    const body = new FormData();
    for (const file of files) body.append("files", file);
    body.append("trims", JSON.stringify(options.trims));
    body.append("transition", options.transition);
    body.append("transitionMs", String(options.transitionMs));
    body.append("normalize", String(options.normalize));
    body.append("format", options.format);
    return requestBlob("/api/tools/join", body);
  },
};

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function subscribeToJob(
  jobId: string,
  onProgress: (event: JobEventPayload) => void,
  onDisconnected?: () => void,
): () => void {
  const source = new EventSource(apiUrl(`/api/jobs/${jobId}/events`));
  source.addEventListener("progress", (event) => {
    onProgress(JSON.parse((event as MessageEvent<string>).data) as JobEventPayload);
  });
  source.onerror = () => onDisconnected?.();
  return () => source.close();
}
