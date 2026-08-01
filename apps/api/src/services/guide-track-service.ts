import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runProcess } from "@audiotool/audio-engine";
import type { GuideCue, GuideVoice } from "@audiotool/contracts";

const sampleRate = 24_000;
let voicesPromise: Promise<GuideVoice[]> | null = null;
const groqVoices: GuideVoice[] = [
  {
    name: "hannah",
    displayName: "Hannah · Crisp guide",
    culture: "en-US",
    gender: "Female",
    provider: "groq",
    description: "Recommended for short, clear worship cues.",
  },
  {
    name: "autumn",
    displayName: "Autumn · Warm guide",
    culture: "en-US",
    gender: "Female",
    provider: "groq",
    description: "Natural and warm, with a softer attack.",
  },
  {
    name: "diana",
    displayName: "Diana · Direct guide",
    culture: "en-US",
    gender: "Female",
    provider: "groq",
    description: "A direct alternate female cue voice.",
  },
];

async function listEdgeVoices(workerUrl: string): Promise<GuideVoice[]> {
  try {
    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/v1/guide-voices`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { voices?: unknown[] };
    if (!Array.isArray(payload.voices)) return [];
    return payload.voices.flatMap((voice): GuideVoice[] => {
      if (!voice || typeof voice !== "object") return [];
      const item = voice as Record<string, unknown>;
      if (
        typeof item.name !== "string" ||
        typeof item.displayName !== "string" ||
        typeof item.culture !== "string" ||
        typeof item.description !== "string" ||
        item.provider !== "edge"
      ) {
        return [];
      }
      const gender = ["Female", "Male", "Neutral"].includes(String(item.gender))
        ? (String(item.gender) as GuideVoice["gender"])
        : "Unknown";
      return [
        {
          name: item.name,
          displayName: item.displayName,
          culture: item.culture,
          gender,
          provider: "edge",
          description: item.description,
        },
      ];
    });
  } catch {
    return [];
  }
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodePowerShellJson(value: string): unknown {
  const normalized = value.replace(/^\uFEFF/, "").trim();
  return normalized ? JSON.parse(normalized) : [];
}

export async function listSystemVoices(): Promise<GuideVoice[]> {
  if (process.platform !== "win32") return [];
  voicesPromise ??= (async () => {
    const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voices = @($synth.GetInstalledVoices() | ForEach-Object {
    [PSCustomObject]@{
      name = $_.VoiceInfo.Name
      culture = $_.VoiceInfo.Culture.Name
      gender = $_.VoiceInfo.Gender.ToString()
    }
  })
  [Console]::Write(($voices | ConvertTo-Json -Compress))
} finally {
  $synth.Dispose()
}`;
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)],
      { timeoutMs: 15_000 },
    );
    const parsed = decodePowerShellJson(result.stdout);
    const voiceItems = Array.isArray(parsed) ? parsed : [parsed];
    return voiceItems.flatMap((voice): GuideVoice[] => {
      if (!voice || typeof voice !== "object") return [];
      const item = voice as Record<string, unknown>;
      if (typeof item.name !== "string" || typeof item.culture !== "string") return [];
      const gender = ["Female", "Male", "Neutral"].includes(String(item.gender))
        ? (String(item.gender) as GuideVoice["gender"])
        : "Unknown";
      return [
        {
          name: item.name,
          displayName: `${item.name} · Offline`,
          culture: item.culture,
          gender,
          provider: "system" as const,
          description: "Offline Windows fallback voice.",
        },
      ];
    });
  })().catch(() => []);
  return voicesPromise;
}

export async function listGuideVoices(options: {
  provider: "auto" | "groq" | "edge" | "system";
  groqApiKey?: string;
  mlWorkerUrl: string;
}): Promise<GuideVoice[]> {
  const groqAvailable = Boolean(options.groqApiKey?.trim());
  if (options.provider === "groq") return groqAvailable ? groqVoices : [];
  if (options.provider === "edge") return listEdgeVoices(options.mlWorkerUrl);
  const systemVoices = await listSystemVoices();
  if (options.provider === "system") return systemVoices;
  const edgeVoices = await listEdgeVoices(options.mlWorkerUrl);
  return [...(groqAvailable ? groqVoices : []), ...edgeVoices, ...systemVoices];
}

export function guideCueTimeMs(
  cue: Pick<GuideCue, "bar" | "beat">,
  bpm: number,
  beatsPerBar: number,
) {
  const beatIndex = (cue.bar - 1) * beatsPerBar + (cue.beat - 1);
  return Math.round(beatIndex * (60_000 / bpm));
}

function writeWavHeader(buffer: Buffer, dataBytes: number) {
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(dataBytes + 36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
}

export function createClickPatternWav(bpm: number, beatsPerBar: number): Buffer {
  const secondsPerBeat = 60 / bpm;
  const frameCount = Math.max(1, Math.ceil(secondsPerBeat * beatsPerBar * sampleRate));
  const dataBytes = frameCount * 2;
  const output = Buffer.allocUnsafe(44 + dataBytes);
  writeWavHeader(output, dataBytes);

  const clickFrames = Math.round(sampleRate * 0.055);
  const framesPerBeat = secondsPerBeat * sampleRate;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const beatIndex = Math.min(beatsPerBar - 1, Math.floor(frame / framesPerBeat));
    const beatStart = Math.round(beatIndex * framesPerBeat);
    const frameInClick = frame - beatStart;
    let value = 0;
    if (frameInClick >= 0 && frameInClick < clickFrames) {
      const seconds = frameInClick / sampleRate;
      const downbeat = beatIndex === 0;
      const compoundSecondary = beatsPerBar >= 6 && beatsPerBar % 3 === 0 && beatIndex === 3;
      const frequency = downbeat ? 1_760 : compoundSecondary ? 1_420 : 1_080;
      const amplitude = downbeat ? 0.92 : compoundSecondary ? 0.72 : 0.56;
      const envelope = Math.exp(-42 * seconds);
      value = Math.sin(2 * Math.PI * frequency * seconds) * amplitude * envelope;
    }
    output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), 44 + frame * 2);
  }
  return output;
}

async function synthesizeSystemCue(
  text: string,
  voiceName: string,
  speechRate: number,
  outputPath: string,
) {
  if (process.platform !== "win32") {
    throw new Error("System speech synthesis is currently available on Windows only.");
  }
  const textBase64 = Buffer.from(text, "utf8").toString("base64");
  const voiceBase64 = Buffer.from(voiceName, "utf8").toString("base64");
  const pathBase64 = Buffer.from(outputPath, "utf8").toString("base64");
  const script = `
Add-Type -AssemblyName System.Speech
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textBase64}'))
$voice = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${voiceBase64}'))
$output = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pathBase64}'))
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $synth.SelectVoice($voice)
  $synth.Rate = ${speechRate}
  $synth.SetOutputToWaveFile($output)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}`;
  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)],
    { timeoutMs: 60_000 },
  );
}

async function synthesizeGroqCue(options: {
  text: string;
  voiceName: string;
  apiKey: string;
  model: string;
  outputPath: string;
}) {
  const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      voice: options.voiceName,
      input: `[professionally] ${options.text}`,
      response_format: "wav",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(payload.error?.message ?? `Groq speech synthesis returned ${response.status}.`);
  }
  await writeFile(options.outputPath, Buffer.from(await response.arrayBuffer()));
}

async function synthesizeEdgeCue(options: {
  text: string;
  voiceName: string;
  speechRate: number;
  workerUrl: string;
  outputPath: string;
}) {
  const response = await fetch(`${options.workerUrl.replace(/\/$/, "")}/v1/guide-speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: options.text,
      voiceName: options.voiceName,
      speechRate: options.speechRate,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail ?? `Neural speech synthesis returned ${response.status}.`);
  }
  await writeFile(options.outputPath, Buffer.from(await response.arrayBuffer()));
}

export async function renderGuideTrack(options: {
  cues: GuideCue[];
  bpm: number;
  beatsPerBar: number;
  durationMs: number;
  voice: GuideVoice;
  speechRate: number;
  outputPath: string;
  ffmpegPath: string;
  groqApiKey?: string;
  groqModel?: string;
  mlWorkerUrl: string;
}) {
  const temporary = await mkdtemp(join(tmpdir(), "audiotool-guide-"));
  try {
    const cuePaths: string[] = [];
    const synthesized = new Map<string, string>();
    for (const [index, cue] of options.cues.entries()) {
      const cacheKey = cue.text.trim().toLocaleLowerCase();
      const existingPath = synthesized.get(cacheKey);
      if (existingPath) {
        cuePaths.push(existingPath);
        continue;
      }
      const extension = options.voice.provider === "edge" ? "mp3" : "wav";
      const path = join(temporary, `cue-${String(index).padStart(3, "0")}.${extension}`);
      if (options.voice.provider === "groq") {
        if (!options.groqApiKey) throw new Error("GROQ_API_KEY is required for this guide voice.");
        await synthesizeGroqCue({
          text: cue.text,
          voiceName: options.voice.name,
          apiKey: options.groqApiKey,
          model: options.groqModel ?? "canopylabs/orpheus-v1-english",
          outputPath: path,
        });
      } else if (options.voice.provider === "edge") {
        await synthesizeEdgeCue({
          text: cue.text,
          voiceName: options.voice.name,
          speechRate: options.speechRate,
          workerUrl: options.mlWorkerUrl,
          outputPath: path,
        });
      } else {
        await synthesizeSystemCue(cue.text, options.voice.name, options.speechRate, path);
      }
      synthesized.set(cacheKey, path);
      cuePaths.push(path);
    }

    const durationSeconds = (options.durationMs / 1000).toFixed(3);
    const args = [
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-t",
      durationSeconds,
      "-i",
      `anullsrc=r=${sampleRate}:cl=mono`,
    ];
    cuePaths.forEach((path) => args.push("-i", path));
    const filters = options.cues.map((cue, index) => {
      const delay = guideCueTimeMs(cue, options.bpm, options.beatsPerBar);
      const tempo =
        options.voice.provider === "groq"
          ? Math.max(0.7, Math.min(1.4, 1 + options.speechRate * 0.07))
          : 1;
      return `[${index + 1}:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,atempo=${tempo.toFixed(3)},highpass=f=135,lowpass=f=10000,equalizer=f=280:t=q:w=0.9:g=-2,equalizer=f=3200:t=q:w=1.05:g=4,equalizer=f=5600:t=q:w=1.2:g=1.5,acompressor=threshold=0.1:ratio=4:attack=3:release=65:makeup=2.2,adelay=${delay}:all=1[cue${index}]`;
    });
    const inputs = ["[0:a]", ...options.cues.map((_, index) => `[cue${index}]`)].join("");
    filters.push(
      `${inputs}amix=inputs=${options.cues.length + 1}:duration=first:normalize=0,alimiter=limit=0.95[out]`,
    );
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-t",
      durationSeconds,
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      options.outputPath,
    );
    await runProcess(options.ffmpegPath, args, { timeoutMs: 600_000 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function renderClickTrack(options: {
  bpm: number;
  beatsPerBar: number;
  durationMs: number;
  outputPath: string;
  ffmpegPath: string;
}) {
  const temporary = await mkdtemp(join(tmpdir(), "audiotool-click-"));
  const patternPath = join(temporary, "bar.wav");
  try {
    await writeFile(patternPath, createClickPatternWav(options.bpm, options.beatsPerBar));
    await runProcess(
      options.ffmpegPath,
      [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-stream_loop",
        "-1",
        "-i",
        patternPath,
        "-t",
        (options.durationMs / 1000).toFixed(3),
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        options.outputPath,
      ],
      { timeoutMs: 600_000 },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
