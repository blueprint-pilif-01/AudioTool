import { spawn } from "node:child_process";

import { z } from "zod";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BufferProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class AudioProcessError extends Error {
  public constructor(
    message: string,
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AudioProcessError";
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new AudioProcessError(error.message, command, null, stderr));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(
          new AudioProcessError(
            timedOut ? `Process timed out: ${command}` : `Process failed: ${command}`,
            command,
            exitCode,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

export async function runProcessBuffer(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BufferProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new AudioProcessError(error.message, command, null, stderr));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(
          new AudioProcessError(
            timedOut ? `Process timed out: ${command}` : `Process failed: ${command}`,
            command,
            exitCode,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: 0 });
    });
  });
}

const ffprobeSchema = z.object({
  format: z
    .object({
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      format_name: z.string().optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        sample_rate: z.string().optional(),
        channels: z.number().optional(),
        duration: z.string().optional(),
        bit_rate: z.string().optional(),
      }),
    )
    .default([]),
});

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  bitrate: number | null;
  formatName: string | null;
}

function optionalPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function probeAudio(
  inputPath: string,
  ffprobePath = "ffprobe",
): Promise<AudioMetadata> {
  const result = await runProcess(
    ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath],
    { timeoutMs: 30_000 },
  );
  const parsed = ffprobeSchema.parse(JSON.parse(result.stdout));
  const audioStream = parsed.streams.find((stream) => stream.codec_type === "audio");
  if (!audioStream) {
    throw new Error("The uploaded file does not contain an audio stream.");
  }
  const durationSeconds = Number.parseFloat(audioStream.duration ?? parsed.format?.duration ?? "0");
  const durationMs = Math.max(0, Math.round(durationSeconds * 1000));

  return {
    durationMs,
    sampleRate: optionalPositiveInt(audioStream.sample_rate),
    channels: audioStream.channels ?? null,
    codec: audioStream.codec_name ?? null,
    bitrate: optionalPositiveInt(audioStream.bit_rate ?? parsed.format?.bit_rate),
    formatName: parsed.format?.format_name ?? null,
  };
}

export async function extractWaveformPeaks(
  inputPath: string,
  pointCount = 1_024,
  ffmpegPath = "ffmpeg",
  signal?: AbortSignal,
): Promise<number[]> {
  if (!Number.isInteger(pointCount) || pointCount < 64 || pointCount > 4_096) {
    throw new Error("Waveform point count must be an integer between 64 and 4096.");
  }
  const result = await runProcessBuffer(
    ffmpegPath,
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "400",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { timeoutMs: 180_000, ...(signal ? { signal } : {}) },
  );
  const sampleCount = Math.floor(result.stdout.byteLength / 4);
  if (sampleCount === 0) throw new Error("The audio file did not produce waveform samples.");
  const peaks = new Float32Array(pointCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const bucket = Math.min(pointCount - 1, Math.floor((index / sampleCount) * pointCount));
    peaks[bucket] = Math.max(peaks[bucket] ?? 0, Math.abs(result.stdout.readFloatLE(index * 4)));
  }
  return Array.from(peaks, (value) => Math.round(Math.min(1, value) * 10_000) / 10_000);
}

export function buildPlaybackPreviewArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-map_metadata",
    "-1",
    "-ar",
    "44100",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    outputPath,
  ];
}

export async function createPlaybackPreview(
  inputPath: string,
  outputPath: string,
  ffmpegPath = "ffmpeg",
  signal?: AbortSignal,
): Promise<void> {
  await runProcess(ffmpegPath, buildPlaybackPreviewArgs(inputPath, outputPath), {
    timeoutMs: 300_000,
    ...(signal ? { signal } : {}),
  });
}

export function buildMockStemArgs(inputPath: string, outputPath: string, gainDb: number): string[] {
  if (!Number.isFinite(gainDb) || gainDb < -60 || gainDb > 12) {
    throw new Error("Mock stem gain must be between -60 and 12 dB.");
  }
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-af",
    `volume=${gainDb.toFixed(2)}dB`,
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

export async function createMockStem(
  inputPath: string,
  outputPath: string,
  options: { ffmpegPath?: string; gainDb?: number; signal?: AbortSignal } = {},
): Promise<void> {
  await runProcess(
    options.ffmpegPath ?? "ffmpeg",
    buildMockStemArgs(inputPath, outputPath, options.gainDb ?? -12),
    {
      timeoutMs: 180_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export async function measureReconstructionErrorDb(
  sourcePath: string,
  stemPaths: readonly string[],
  ffmpegPath = "ffmpeg",
  signal?: AbortSignal,
): Promise<number> {
  if (stemPaths.length === 0) throw new Error("At least one stem is required for reconstruction.");
  const args = ["-nostdin", "-v", "info", "-i", sourcePath];
  for (const stemPath of stemPaths) args.push("-i", stemPath);
  const filters: string[] = [];
  if (stemPaths.length === 1) filters.push("[1:a]anull[sum]");
  else {
    filters.push(
      `${stemPaths.map((_, index) => `[${index + 1}:a]`).join("")}amix=inputs=${stemPaths.length}:duration=first:normalize=0[sum]`,
    );
  }
  filters.push("[0:a]volume=-1[negative]");
  filters.push(`[sum][negative]amix=inputs=2:duration=first:normalize=0,volumedetect[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-f", "null", "-");
  const result = await runProcess(ffmpegPath, args, {
    timeoutMs: 600_000,
    ...(signal ? { signal } : {}),
  });
  const match = /mean_volume:\s*(-inf|-?\d+(?:\.\d+)?)\s*dB/i.exec(result.stderr);
  if (!match?.[1]) throw new Error("FFmpeg did not report reconstruction RMS error.");
  return match[1].toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

export type AudioExportFormat = "wav" | "mp3" | "flac";

export interface MixRenderTrack {
  inputPath: string;
  startMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
  volumeDb: number;
  pan: number;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

export function buildMixRenderArgs(
  tracks: readonly MixRenderTrack[],
  outputPath: string,
  masterVolumeDb = 0,
  format: AudioExportFormat = "wav",
): string[] {
  const audibleTracks = tracks.filter((track) => !track.muted);
  if (audibleTracks.length === 0) throw new Error("At least one audible track is required.");
  if (!Number.isFinite(masterVolumeDb) || masterVolumeDb < -60 || masterVolumeDb > 12) {
    throw new Error("Master volume must be between -60 and 12 dB.");
  }

  const args = ["-nostdin", "-y", "-v", "error"];
  for (const track of audibleTracks) args.push("-i", track.inputPath);

  const chains: string[] = [];
  audibleTracks.forEach((track, index) => {
    const effectiveDurationMs = Math.max(1, track.durationMs - track.trimStartMs - track.trimEndMs);
    const fadeOutStartMs = Math.max(0, effectiveDurationMs - track.fadeOutMs);
    const filters = [
      `atrim=start=${seconds(track.trimStartMs)}:duration=${seconds(effectiveDurationMs)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${track.volumeDb.toFixed(2)}dB`,
      `stereotools=balance_out=${track.pan.toFixed(3)}`,
    ];
    if (track.fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${seconds(track.fadeInMs)}`);
    if (track.fadeOutMs > 0) {
      filters.push(`afade=t=out:st=${seconds(fadeOutStartMs)}:d=${seconds(track.fadeOutMs)}`);
    }
    if (track.startMs > 0) filters.push(`adelay=${track.startMs}|${track.startMs}`);
    chains.push(`[${index}:a]${filters.join(",")}[a${index}]`);
  });
  const labels = audibleTracks.map((_, index) => `[a${index}]`).join("");
  chains.push(
    `${labels}amix=inputs=${audibleTracks.length}:duration=longest:normalize=0,volume=${masterVolumeDb.toFixed(2)}dB,alimiter=limit=0.95[out]`,
  );

  args.push(
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[out]",
    ...audioCodecArgs(format),
    outputPath,
  );
  return args;
}

function atempoChain(factor: number): string[] {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Tempo factor must be positive.");
  const filters: string[] = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

export function buildPitchTempoArgs(
  inputPath: string,
  outputPath: string,
  pitchSemitones: number,
  tempoPercent: number,
  sampleRate: number,
): string[] {
  if (!Number.isFinite(pitchSemitones) || pitchSemitones < -12 || pitchSemitones > 12) {
    throw new Error("Pitch must be between -12 and 12 semitones.");
  }
  if (!Number.isFinite(tempoPercent) || tempoPercent < 50 || tempoPercent > 200) {
    throw new Error("Tempo must be between 50 and 200 percent.");
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new Error("A valid sample rate is required.");
  }
  const pitchFactor = 2 ** (pitchSemitones / 12);
  const tempoFactor = tempoPercent / 100;
  const compensation = tempoFactor / pitchFactor;
  const filters = [
    `asetrate=${Math.round(sampleRate * pitchFactor)}`,
    `aresample=${sampleRate}`,
    ...atempoChain(compensation),
  ];
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-af",
    filters.join(","),
    "-c:a",
    "pcm_s24le",
    outputPath,
  ];
}

export interface PitchTempoRenderRequest {
  inputPath: string;
  outputPath: string;
  pitchSemitones: number;
  tempoPercent: number;
  sampleRate: number;
  signal?: AbortSignal;
}

export interface PitchTempoAdapter {
  readonly id: string;
  readonly version: string;
  readonly licenseNote: string;
  render(request: PitchTempoRenderRequest): Promise<void>;
}

/**
 * Process-boundary adapter for FFmpeg's built-in resampling and atempo filters.
 * A production deployment must inspect its own FFmpeg build because enabled
 * codecs and compile flags determine whether that binary is LGPL or GPL.
 */
export class FfmpegPitchTempoAdapter implements PitchTempoAdapter {
  public readonly id = "ffmpeg-resample-atempo";
  public readonly version = "1";
  public readonly licenseNote =
    "FFmpeg is commonly LGPL-2.1-or-later, but GPL-enabled builds are GPL; inspect the deployed binary.";

  public constructor(private readonly ffmpegPath = "ffmpeg") {}

  public async render(request: PitchTempoRenderRequest): Promise<void> {
    await runProcess(
      this.ffmpegPath,
      buildPitchTempoArgs(
        request.inputPath,
        request.outputPath,
        request.pitchSemitones,
        request.tempoPercent,
        request.sampleRate,
      ),
      {
        timeoutMs: 300_000,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
  }
}

export function buildCutterArgs(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  fadeInMs: number,
  fadeOutMs: number,
): string[] {
  if (![startMs, endMs, fadeInMs, fadeOutMs].every(Number.isFinite)) {
    throw new Error("Cutter values must be finite numbers.");
  }
  if (startMs < 0 || endMs <= startMs || fadeInMs < 0 || fadeOutMs < 0) {
    throw new Error("Invalid cutter range or fade duration.");
  }
  const durationMs = endMs - startMs;
  if (fadeInMs > durationMs || fadeOutMs > durationMs) {
    throw new Error("Fade durations cannot exceed the selected range.");
  }
  const filters = [`atrim=start=${seconds(startMs)}:end=${seconds(endMs)}`, "asetpts=PTS-STARTPTS"];
  if (fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${seconds(fadeInMs)}`);
  if (fadeOutMs > 0) {
    filters.push(`afade=t=out:st=${seconds(durationMs - fadeOutMs)}:d=${seconds(fadeOutMs)}`);
  }
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-af",
    filters.join(","),
    "-c:a",
    "pcm_s24le",
    outputPath,
  ];
}

export type CutterOperation = "keep" | "remove";

export interface CutterRegion {
  startMs: number;
  endMs: number;
}

function audioCodecArgs(format: AudioExportFormat): string[] {
  switch (format) {
    case "wav":
      return ["-c:a", "pcm_s24le"];
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2"];
    case "flac":
      return ["-c:a", "flac", "-compression_level", "8"];
  }
}

function normalizeCutterRegions(
  regions: readonly CutterRegion[],
  durationMs: number,
): CutterRegion[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("A positive source duration is required.");
  }
  const sorted = regions
    .map((region) => ({ startMs: region.startMs, endMs: region.endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  const merged: CutterRegion[] = [];
  for (const region of sorted) {
    if (
      !Number.isFinite(region.startMs) ||
      !Number.isFinite(region.endMs) ||
      region.startMs < 0 ||
      region.endMs <= region.startMs ||
      region.endMs > durationMs
    ) {
      throw new Error("Every cutter region must be inside the source duration.");
    }
    const previous = merged.at(-1);
    if (previous && region.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
    } else {
      merged.push(region);
    }
  }
  return merged;
}

export function buildRegionCutterArgs(
  inputPath: string,
  outputPath: string,
  durationMs: number,
  regions: readonly CutterRegion[],
  operation: CutterOperation,
  fadeInMs: number,
  fadeOutMs: number,
  format: AudioExportFormat,
): string[] {
  if (![fadeInMs, fadeOutMs].every(Number.isFinite) || fadeInMs < 0 || fadeOutMs < 0) {
    throw new Error("Fade durations must be non-negative finite numbers.");
  }
  const selected = normalizeCutterRegions(regions, durationMs);
  if (selected.length === 0) throw new Error("At least one cutter region is required.");
  const kept: CutterRegion[] = [];
  if (operation === "keep") {
    kept.push(...selected);
  } else {
    let cursor = 0;
    for (const region of selected) {
      if (region.startMs > cursor) kept.push({ startMs: cursor, endMs: region.startMs });
      cursor = region.endMs;
    }
    if (cursor < durationMs) kept.push({ startMs: cursor, endMs: durationMs });
  }
  if (kept.length === 0) throw new Error("The cutter operation would produce an empty file.");
  if (
    kept.some(
      (region) =>
        fadeInMs > region.endMs - region.startMs || fadeOutMs > region.endMs - region.startMs,
    )
  ) {
    throw new Error("Fade durations cannot exceed any retained region.");
  }

  const filters: string[] = [];
  if (kept.length > 1) {
    filters.push(`[0:a]asplit=${kept.length}${kept.map((_, index) => `[src${index}]`).join("")}`);
  }
  kept.forEach((region, index) => {
    const duration = region.endMs - region.startMs;
    const chain = [
      `atrim=start=${seconds(region.startMs)}:end=${seconds(region.endMs)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${seconds(fadeInMs)}`);
    if (fadeOutMs > 0) {
      chain.push(`afade=t=out:st=${seconds(duration - fadeOutMs)}:d=${seconds(fadeOutMs)}`);
    }
    filters.push(`${kept.length > 1 ? `[src${index}]` : "[0:a]"}${chain.join(",")}[c${index}]`);
  });
  if (kept.length === 1) filters.push("[c0]anull[out]");
  else {
    filters.push(
      `${kept.map((_, index) => `[c${index}]`).join("")}concat=n=${kept.length}:v=0:a=1[out]`,
    );
  }
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    ...audioCodecArgs(format),
    outputPath,
  ];
}

export function buildJoinerArgs(
  inputPaths: readonly string[],
  outputPath: string,
  crossfadeMs: number,
): string[] {
  if (inputPaths.length < 2 || inputPaths.length > 20) {
    throw new Error("Joiner requires between 2 and 20 audio inputs.");
  }
  if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0 || crossfadeMs > 5000) {
    throw new Error("Crossfade must be between 0 and 5000 milliseconds.");
  }
  const args = ["-nostdin", "-y", "-v", "error"];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const filters = inputPaths.map(
    (_, index) =>
      `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[s${index}]`,
  );
  if (crossfadeMs === 0) {
    filters.push(
      `${inputPaths.map((_, index) => `[s${index}]`).join("")}concat=n=${inputPaths.length}:v=0:a=1[out]`,
    );
  } else {
    let previous = "s0";
    for (let index = 1; index < inputPaths.length; index += 1) {
      const output = index === inputPaths.length - 1 ? "out" : `x${index}`;
      filters.push(
        `[${previous}][s${index}]acrossfade=d=${seconds(crossfadeMs)}:c1=tri:c2=tri[${output}]`,
      );
      previous = output;
    }
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_s24le", outputPath);
  return args;
}

export type JoinTransition = "none" | "pause" | "crossfade";

export interface JoinTrim {
  startMs: number;
  endMs: number;
}

export function buildAdvancedJoinerArgs(
  inputPaths: readonly string[],
  outputPath: string,
  trims: readonly JoinTrim[],
  transition: JoinTransition,
  transitionMs: number,
  normalize: boolean,
  format: AudioExportFormat,
): string[] {
  if (inputPaths.length < 2 || inputPaths.length > 20 || trims.length !== inputPaths.length) {
    throw new Error("Joiner requires matching trim data for 2 to 20 audio inputs.");
  }
  if (!Number.isFinite(transitionMs) || transitionMs < 0 || transitionMs > 5000) {
    throw new Error("Join transition must be between 0 and 5000 milliseconds.");
  }
  const durations = trims.map((trim) => {
    if (
      !Number.isFinite(trim.startMs) ||
      !Number.isFinite(trim.endMs) ||
      trim.startMs < 0 ||
      trim.endMs <= trim.startMs
    ) {
      throw new Error("Each joiner trim must have a positive duration.");
    }
    return trim.endMs - trim.startMs;
  });
  if (transition === "crossfade" && durations.some((duration) => transitionMs >= duration)) {
    throw new Error("Crossfade must be shorter than every trimmed input.");
  }

  const args = ["-nostdin", "-y", "-v", "error"];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const filters = trims.map((trim, index) => {
    const normalizer = normalize ? ",loudnorm=I=-16:LRA=11:TP=-1.5" : "";
    return `[${index}:a]atrim=start=${seconds(trim.startMs)}:end=${seconds(trim.endMs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${normalizer}[s${index}]`;
  });

  if (transition === "crossfade" && transitionMs > 0) {
    let previous = "s0";
    for (let index = 1; index < inputPaths.length; index += 1) {
      const output = index === inputPaths.length - 1 ? "out" : `x${index}`;
      filters.push(
        `[${previous}][s${index}]acrossfade=d=${seconds(transitionMs)}:c1=tri:c2=tri[${output}]`,
      );
      previous = output;
    }
  } else {
    const labels: string[] = [];
    for (let index = 0; index < inputPaths.length; index += 1) {
      labels.push(`[s${index}]`);
      if (transition === "pause" && transitionMs > 0 && index < inputPaths.length - 1) {
        filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(transitionMs)}[g${index}]`);
        labels.push(`[g${index}]`);
      }
    }
    filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    ...audioCodecArgs(format),
    outputPath,
  );
  return args;
}

const keyNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"] as const;
const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyBpmAnalysis {
  key: (typeof keyNames)[number];
  scale: "major" | "minor";
  bpm: number;
  confidence: number;
  analyzedDurationMs: number;
}

function estimateTempo(
  samples: Float32Array,
  sampleRate: number,
): { bpm: number; confidence: number } {
  const frameSize = 512;
  const hop = 256;
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hop));
  const onset = new Float64Array(frameCount);
  let previousEnergy = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let energy = 0;
    const offset = frame * hop;
    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[offset + index] ?? 0;
      energy += sample * sample;
    }
    const change = energy - previousEnergy;
    onset[frame] = Math.max(0, change);
    previousEnergy = energy;
  }
  const mean = onset.reduce((sum, value) => sum + value, 0) / Math.max(1, onset.length);
  for (let index = 0; index < onset.length; index += 1)
    onset[index] = Math.max(0, onset[index]! - mean);
  const envelopeRate = sampleRate / hop;
  const minLag = Math.max(1, Math.floor((60 * envelopeRate) / 200));
  const maxLag = Math.min(onset.length - 1, Math.ceil((60 * envelopeRate) / 60));
  let bestLag = minLag;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let index = lag; index < onset.length; index += 1)
      score += onset[index]! * onset[index - lag]!;
    score *= 1 + 0.08 * Math.cos(((lag - minLag) / Math.max(1, maxLag - minLag)) * Math.PI);
    scoreSum += score;
    scoreCount += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const bpm = (60 * envelopeRate) / bestLag;
  const average = scoreSum / Math.max(1, scoreCount);
  const confidence =
    bestScore > 0 ? Math.max(0.05, Math.min(0.98, (bestScore - average) / bestScore)) : 0.05;
  return { bpm: Math.round(bpm * 10) / 10, confidence };
}

function goertzelPower(
  samples: Float32Array,
  offset: number,
  length: number,
  frequency: number,
  sampleRate: number,
): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = 0; index < length; index += 1) {
    const value = samples[offset + index] ?? 0;
    const current = value + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return (
    previousPrevious * previousPrevious +
    previous * previous -
    coefficient * previous * previousPrevious
  );
}

function estimateKey(
  samples: Float32Array,
  sampleRate: number,
): { key: (typeof keyNames)[number]; scale: "major" | "minor"; confidence: number } {
  const chroma = new Float64Array(12);
  const frameSize = 4096;
  const usableFrames = Math.min(180, Math.floor(samples.length / frameSize));
  for (let frame = 0; frame < usableFrames; frame += 1) {
    const offset = frame * frameSize;
    for (let midi = 36; midi <= 83; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const pitchClass = midi % 12;
      chroma[pitchClass] =
        (chroma[pitchClass] ?? 0) +
        goertzelPower(samples, offset, frameSize, frequency, sampleRate);
    }
  }
  const total = chroma.reduce((sum, value) => sum + value, 0) || 1;
  for (let index = 0; index < chroma.length; index += 1)
    chroma[index] = (chroma[index] ?? 0) / total;
  const candidates: Array<{ root: number; scale: "major" | "minor"; score: number }> = [];
  for (let root = 0; root < 12; root += 1) {
    for (const [scale, profile] of [
      ["major", majorProfile],
      ["minor", minorProfile],
    ] as const) {
      let score = 0;
      for (let pitch = 0; pitch < 12; pitch += 1)
        score += chroma[(root + pitch) % 12]! * profile[pitch]!;
      candidates.push({ root, scale, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? { root: 0, scale: "major" as const, score: 1 };
  const second = candidates[1]?.score ?? 0;
  return {
    key: keyNames[best.root] ?? "C",
    scale: best.scale,
    confidence: Math.max(
      0.05,
      Math.min(0.95, ((best.score - second) / Math.max(best.score, 0.000001)) * 4),
    ),
  };
}

export async function analyzeKeyBpm(
  inputPath: string,
  ffmpegPath = "ffmpeg",
  signal?: AbortSignal,
): Promise<KeyBpmAnalysis> {
  const sampleRate = 8000;
  const result = await runProcessBuffer(
    ffmpegPath,
    [
      "-nostdin",
      "-v",
      "error",
      "-t",
      "90",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { timeoutMs: 120_000, ...(signal ? { signal } : {}) },
  );
  const sampleCount = Math.floor(result.stdout.byteLength / 4);
  if (sampleCount < sampleRate * 2)
    throw new Error("At least two seconds of audio are required for analysis.");
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1)
    samples[index] = result.stdout.readFloatLE(index * 4);
  const tempo = estimateTempo(samples, sampleRate);
  const key = estimateKey(samples, sampleRate);
  return {
    ...key,
    bpm: tempo.bpm,
    confidence: Math.round(((tempo.confidence + key.confidence) / 2) * 100) / 100,
    analyzedDurationMs: Math.round((sampleCount / sampleRate) * 1000),
  };
}
