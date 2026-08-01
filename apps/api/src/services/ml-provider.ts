import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  instrumentDisplayNames,
  instrumentDetectionSchema,
  instrumentLabels,
  mlProviderCapabilitiesSchema,
  type InstrumentDetection,
  type InstrumentLabel,
  type SeparationMode,
  type VocalBreakdownAnalysis,
  type VocalBreakdownPart,
} from "@audiotool/contracts";
import { Agent } from "undici";
import { z } from "zod";

export interface InstrumentDetectionInput {
  audioPath: string;
  checksum: string;
  durationMs: number;
  signal?: AbortSignal;
}

export interface StemSeparationInput {
  audioPath: string;
  checksum: string;
  targetLabel: InstrumentLabel;
  outputPath: string;
  separationMode: SeparationMode;
  signal?: AbortSignal;
}

export interface StemSeparationResult {
  provider: string;
  modelName: string;
  modelVersion: string;
}

export interface VocalBreakdownInput {
  audioPath: string;
  checksum: string;
  durationMs: number;
  signal?: AbortSignal;
}

export interface VocalBreakdownRenderInput extends VocalBreakdownInput {
  part: VocalBreakdownPart;
  outputPath: string;
}

export interface VocalBreakdownRenderResult {
  provider: string;
  modelName: string;
  modelVersion: string;
  confidence: number;
  coverage: number;
}

export interface MlProviderCapabilities {
  provider: string;
  modelName: string;
  modelVersion: string;
  supportedLabels: InstrumentLabel[];
  dynamicStemCount: boolean;
  limitations: string[];
  mock: boolean;
}

const detectionResponseSchema = z.object({
  detections: z.array(instrumentDetectionSchema),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
});

const capabilitiesResponseSchema = mlProviderCapabilitiesSchema.omit({ mock: true });
const vocalBreakdownAnalysisResponseSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  voicedDurationMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  lowestNote: z.string().nullable(),
  highestNote: z.string().nullable(),
  medianNote: z.string().nullable(),
  notes: z.array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
      midi: z.number().int(),
      note: z.string(),
      frequencyHz: z.number().positive(),
      confidence: z.number().min(0).max(1),
      register: z.enum(["soprano", "alto", "tenor", "bass"]),
    }),
  ),
  registers: z.array(
    z.object({
      part: z.enum(["soprano", "alto", "tenor", "bass"]),
      displayName: z.string(),
      range: z.string(),
      coverage: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  modelName: z.string(),
  modelVersion: z.string(),
  methodology: z.literal("dominant-pitch-register-gating"),
  experimental: z.literal(true),
});

interface AbortScope {
  signal: AbortSignal;
  dispose: () => void;
}

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("ML worker request timed out.")),
    timeoutMs,
  );
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

type NodeRequestInit = RequestInit & { dispatcher: Agent; duplex: "half" };

export class HttpMlProvider implements MlProvider {
  public readonly name: string;
  public readonly modelName: string;
  public readonly modelVersion = "worker-reported";
  private readonly dispatcher: Agent;

  public constructor(
    private readonly workerUrl: string,
    private readonly timeoutMs: number,
    profile = "configured",
  ) {
    this.name = `${profile}_http`;
    this.modelName = `${profile}-compatible-worker`;
    this.dispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  private async withAudioResponse<T>(
    path: string,
    endpoint: string,
    headers: Record<string, string>,
    consume: (response: Response) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = createAbortScope(signal, this.timeoutMs);
    try {
      const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      const response = await fetch(`${this.workerUrl.replace(/\/$/, "")}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...headers },
        body,
        duplex: "half",
        dispatcher: this.dispatcher,
        signal: scope.signal,
      } as NodeRequestInit);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail ?? `ML worker returned ${response.status}.`);
      }
      return await consume(response);
    } finally {
      scope.dispose();
    }
  }

  public async detectInstruments(input: InstrumentDetectionInput): Promise<InstrumentDetection[]> {
    return this.withAudioResponse(
      input.audioPath,
      "/v1/detect",
      {
        "X-Audio-Checksum": input.checksum,
        "X-Audio-Duration-Ms": String(input.durationMs),
      },
      async (response) => detectionResponseSchema.parse(await response.json()).detections,
      input.signal,
    );
  }

  public async separateStem(input: StemSeparationInput): Promise<StemSeparationResult> {
    try {
      return await this.withAudioResponse(
        input.audioPath,
        `/v1/separate/${encodeURIComponent(input.targetLabel)}`,
        {
          "X-Audio-Checksum": input.checksum,
          "X-AudioTool-Separation-Mode": input.separationMode,
        },
        async (response) => {
          if (!response.body) throw new Error("ML worker returned an empty audio response.");
          const result = {
            provider: response.headers.get("X-AudioTool-Provider") ?? this.name,
            modelName: response.headers.get("X-AudioTool-Model-Name") ?? this.modelName,
            modelVersion: response.headers.get("X-AudioTool-Model-Version") ?? this.modelVersion,
          };
          const stream = Readable.fromWeb(response.body as NodeReadableStream);
          await pipeline(stream, createWriteStream(input.outputPath, { flags: "wx" }));
          return result;
        },
        input.signal,
      );
    } catch (error) {
      await rm(input.outputPath, { force: true });
      throw error;
    }
  }

  public async analyzeVocalBreakdown(input: VocalBreakdownInput): Promise<VocalBreakdownAnalysis> {
    return this.withAudioResponse(
      input.audioPath,
      "/v1/vocal-breakdown/analyze",
      { "X-Audio-Checksum": input.checksum },
      async (response) => vocalBreakdownAnalysisResponseSchema.parse(await response.json()),
      input.signal,
    );
  }

  public async renderVocalBreakdownPart(
    input: VocalBreakdownRenderInput,
  ): Promise<VocalBreakdownRenderResult> {
    try {
      return await this.withAudioResponse(
        input.audioPath,
        `/v1/vocal-breakdown/${encodeURIComponent(input.part)}`,
        { "X-Audio-Checksum": input.checksum },
        async (response) => {
          if (!response.body) throw new Error("ML worker returned an empty audio response.");
          const stream = Readable.fromWeb(response.body as NodeReadableStream);
          await pipeline(stream, createWriteStream(input.outputPath, { flags: "wx" }));
          return {
            provider: response.headers.get("X-AudioTool-Provider") ?? this.name,
            modelName: response.headers.get("X-AudioTool-Model-Name") ?? this.modelName,
            modelVersion: response.headers.get("X-AudioTool-Model-Version") ?? this.modelVersion,
            confidence: Number(response.headers.get("X-AudioTool-Confidence") ?? 0),
            coverage: Number(response.headers.get("X-AudioTool-Coverage") ?? 0),
          };
        },
        input.signal,
      );
    } catch (error) {
      await rm(input.outputPath, { force: true });
      throw error;
    }
  }

  public async getCapabilities(): Promise<MlProviderCapabilities> {
    const scope = createAbortScope(undefined, Math.min(this.timeoutMs, 5_000));
    try {
      const response = await fetch(`${this.workerUrl.replace(/\/$/, "")}/v1/info`, {
        dispatcher: this.dispatcher,
        signal: scope.signal,
      } as RequestInit & { dispatcher: Agent });
      if (!response.ok) throw new Error(`ML worker returned ${response.status}.`);
      const capabilities = capabilitiesResponseSchema.parse(await response.json());
      return { ...capabilities, mock: false };
    } finally {
      scope.dispose();
    }
  }

  public async checkHealth(): Promise<{ ok: boolean; detail: string }> {
    const scope = createAbortScope(undefined, Math.min(this.timeoutMs, 5_000));
    try {
      const response = await fetch(`${this.workerUrl.replace(/\/$/, "")}/health`, {
        dispatcher: this.dispatcher,
        signal: scope.signal,
      } as RequestInit & { dispatcher: Agent });
      const payload = (await response.json().catch(() => ({}))) as {
        available?: boolean;
        modelName?: string;
        modelVersion?: string;
      };
      return {
        ok: response.ok && payload.available === true,
        detail:
          payload.modelName && payload.modelVersion
            ? `${payload.modelName} (${payload.modelVersion})`
            : (payload.modelName ?? "ML worker unavailable"),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "ML worker unavailable",
      };
    } finally {
      scope.dispose();
    }
  }
}

export interface InstrumentDetectionProvider {
  readonly name: string;
  readonly modelName: string;
  readonly modelVersion: string;
  detectInstruments(input: InstrumentDetectionInput): Promise<InstrumentDetection[]>;
}

export interface StemSeparationProvider {
  readonly name: string;
  readonly modelName: string;
  readonly modelVersion: string;
  separateStem(input: StemSeparationInput): Promise<StemSeparationResult>;
  getCapabilities(): Promise<MlProviderCapabilities>;
  checkHealth(): Promise<{ ok: boolean; detail: string }>;
}

export interface MlProvider extends InstrumentDetectionProvider, StemSeparationProvider {
  analyzeVocalBreakdown(input: VocalBreakdownInput): Promise<VocalBreakdownAnalysis>;
  renderVocalBreakdownPart(input: VocalBreakdownRenderInput): Promise<VocalBreakdownRenderResult>;
}

export class DemucsHttpProvider extends HttpMlProvider {
  public constructor(workerUrl: string, timeoutMs: number) {
    super(workerUrl, timeoutMs, "demucs");
  }
}

export class BanquetHttpProvider extends HttpMlProvider {
  public constructor(workerUrl: string, timeoutMs: number) {
    super(workerUrl, timeoutMs, "banquet");
  }
}

export class SamAudioHttpProvider extends HttpMlProvider {
  public constructor(workerUrl: string, timeoutMs: number) {
    super(workerUrl, timeoutMs, "sam-audio");
  }
}

export class AudioSepHttpProvider extends HttpMlProvider {
  public constructor(workerUrl: string, timeoutMs: number) {
    super(workerUrl, timeoutMs, "audiosep");
  }
}

const candidateLabels: InstrumentLabel[] = [
  "vocals",
  "drums",
  "bass_guitar",
  "electric_guitar",
  "piano",
  "synthesizer",
  "strings",
  "percussion",
];

export class MockMlProvider implements MlProvider {
  public readonly name = "mock";
  public readonly modelName = "deterministic-development-provider";
  public readonly modelVersion = "1.0.0";

  public constructor(
    private readonly createStem: (
      inputPath: string,
      outputPath: string,
      options: { gainDb: number; signal?: AbortSignal },
    ) => Promise<void>,
  ) {}

  public async detectInstruments(input: InstrumentDetectionInput): Promise<InstrumentDetection[]> {
    const digest = createHash("sha256").update(input.checksum).digest();
    const optionalCount = 2 + ((digest[0] ?? 0) % 3);
    const labels = candidateLabels.slice(0, 4 + optionalCount);
    return Promise.resolve(
      labels.map((canonicalLabel, index) => ({
        canonicalLabel,
        displayLabel: instrumentDisplayNames[canonicalLabel],
        confidence: Math.max(0.35, 0.98 - index * 0.09),
        detectedSpans: [{ startMs: 0, endMs: Math.max(1, input.durationMs) }],
        selected: index < 6,
        manuallyAdded: false,
        modelName: this.modelName,
        modelVersion: this.modelVersion,
      })),
    );
  }

  public async separateStem(input: StemSeparationInput): Promise<StemSeparationResult> {
    const labelOffset = candidateLabels.indexOf(input.targetLabel);
    const gainDb = -9 - Math.max(0, labelOffset) * 1.25;
    await this.createStem(input.audioPath, input.outputPath, {
      gainDb,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      provider: this.name,
      modelName: this.modelName,
      modelVersion: this.modelVersion,
    };
  }

  public analyzeVocalBreakdown(input: VocalBreakdownInput): Promise<VocalBreakdownAnalysis> {
    const registers = (["soprano", "alto", "tenor", "bass"] as const).map((part, index) => ({
      part,
      displayName: `${part[0]?.toUpperCase()}${part.slice(1)} focus`,
      range: ["F♯4–C6", "A♯3–F4", "C3–A3", "C2–B2"][index] ?? "",
      coverage: 0.25,
      confidence: 0.4,
    }));
    return Promise.resolve({
      durationMs: input.durationMs,
      voicedDurationMs: Math.round(input.durationMs * 0.62),
      confidence: 0.4,
      lowestNote: "C3",
      highestNote: "C5",
      medianNote: "C4",
      notes: [],
      registers,
      modelName: "deterministic-vocal-breakdown",
      modelVersion: this.modelVersion,
      methodology: "dominant-pitch-register-gating",
      experimental: true,
    });
  }

  public async renderVocalBreakdownPart(
    input: VocalBreakdownRenderInput,
  ): Promise<VocalBreakdownRenderResult> {
    await this.createStem(input.audioPath, input.outputPath, {
      gainDb: input.part === "melody" ? -15 : -9,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      provider: this.name,
      modelName: "deterministic-vocal-breakdown",
      modelVersion: this.modelVersion,
      confidence: 0.4,
      coverage: input.part === "melody" ? 1 : 0.25,
    };
  }

  public getCapabilities(): Promise<MlProviderCapabilities> {
    return Promise.resolve({
      provider: this.name,
      modelName: this.modelName,
      modelVersion: this.modelVersion,
      supportedLabels: [...instrumentLabels],
      dynamicStemCount: true,
      limitations: [
        "Mock output is deterministic test audio and does not represent real source separation.",
      ],
      mock: true,
    });
  }

  public checkHealth(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: `${this.modelName} (mock)` });
  }
}
