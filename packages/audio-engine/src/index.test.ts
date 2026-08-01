import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAdvancedJoinerArgs,
  buildCutterArgs,
  buildJoinerArgs,
  buildMixRenderArgs,
  buildMockStemArgs,
  buildPlaybackPreviewArgs,
  buildPitchTempoArgs,
  buildRegionCutterArgs,
  extractWaveformPeaks,
  measureReconstructionErrorDb,
  runProcess,
} from "./index.js";

describe("buildMockStemArgs", () => {
  it("uses discrete spawn arguments and never a shell expression", () => {
    const args = buildMockStemArgs("C:\\audio files\\song.wav", "C:\\out\\vocals.wav", -12);
    expect(args).toContain("C:\\audio files\\song.wav");
    expect(args).toContain("volume=-12.00dB");
    expect(args.join(" ")).not.toContain("&&");
  });

  it("rejects unsafe gain values", () => {
    expect(() => buildMockStemArgs("in.wav", "out.wav", 99)).toThrow();
  });
});

describe("buildPlaybackPreviewArgs", () => {
  it("creates a compact, seekable mixer preview without shell expressions", () => {
    const args = buildPlaybackPreviewArgs("C:\\audio files\\stem.wav", "preview.mp3");
    expect(args).toContain("libmp3lame");
    expect(args).toContain("192k");
    expect(args).toContain("C:\\audio files\\stem.wav");
    expect(args.at(-1)).toBe("preview.mp3");
    expect(args.join(" ")).not.toContain("&&");
  });
});

describe("buildMixRenderArgs", () => {
  it("builds a deterministic multi-input filter graph", () => {
    const args = buildMixRenderArgs(
      [
        {
          inputPath: "vocals.wav",
          startMs: 0,
          trimStartMs: 100,
          trimEndMs: 200,
          durationMs: 5_000,
          volumeDb: -3,
          pan: -0.2,
          muted: false,
          fadeInMs: 100,
          fadeOutMs: 300,
        },
        {
          inputPath: "drums.wav",
          startMs: 500,
          trimStartMs: 0,
          trimEndMs: 0,
          durationMs: 5_000,
          volumeDb: 0,
          pan: 0.2,
          muted: false,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
      "mix.wav",
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("amix=inputs=2");
    expect(graph).toContain("adelay=500|500");
    expect(args.at(-1)).toBe("mix.wav");
  });

  it("selects MP3 and FLAC codecs for final mix rendering", () => {
    const track = {
      inputPath: "stem.wav",
      startMs: 0,
      trimStartMs: 0,
      trimEndMs: 0,
      durationMs: 1_000,
      volumeDb: 0,
      pan: 0,
      muted: false,
      fadeInMs: 0,
      fadeOutMs: 0,
    };
    expect(buildMixRenderArgs([track], "mix.mp3", 0, "mp3")).toContain("libmp3lame");
    expect(buildMixRenderArgs([track], "mix.flac", 0, "flac")).toContain("flac");
  });
});

describe("audio tool argument builders", () => {
  it("keeps pitch and tempo values inside a filter argument", () => {
    const args = buildPitchTempoArgs("input file.wav", "output.wav", 7, 80, 48_000);
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("asetrate=");
    expect(filter).toContain("atempo=");
    expect(args).toContain("input file.wav");
    expect(args.join(" ")).not.toContain("&&");
  });

  it("validates cutter boundaries and fades", () => {
    const args = buildCutterArgs("in.wav", "out.wav", 1_000, 5_000, 250, 500);
    expect(args[args.indexOf("-af") + 1]).toContain("atrim=start=1.000:end=5.000");
    expect(() => buildCutterArgs("in.wav", "out.wav", 5_000, 1_000, 0, 0)).toThrow();
  });

  it("builds concat and crossfade graphs for ordered inputs", () => {
    const concat = buildJoinerArgs(["one.wav", "two.wav"], "joined.wav", 0);
    expect(concat[concat.indexOf("-filter_complex") + 1]).toContain("concat=n=2");
    const crossfade = buildJoinerArgs(["one.wav", "two.wav", "three.wav"], "joined.wav", 800);
    expect(crossfade[crossfade.indexOf("-filter_complex") + 1]).toContain("acrossfade=d=0.800");
  });

  it("keeps or removes multiple cutter regions and selects the requested codec", () => {
    const keep = buildRegionCutterArgs(
      "in.wav",
      "out.flac",
      10_000,
      [
        { startMs: 500, endMs: 2_000 },
        { startMs: 5_000, endMs: 7_500 },
      ],
      "keep",
      100,
      150,
      "flac",
    );
    const keepGraph = keep[keep.indexOf("-filter_complex") + 1];
    expect(keepGraph).toContain("asplit=2");
    expect(keepGraph).toContain("concat=n=2");
    expect(keep).toContain("flac");

    const remove = buildRegionCutterArgs(
      "in.wav",
      "out.mp3",
      10_000,
      [{ startMs: 2_000, endMs: 4_000 }],
      "remove",
      0,
      0,
      "mp3",
    );
    expect(remove[remove.indexOf("-filter_complex") + 1]).toContain("atrim=start=4.000:end=10.000");
    expect(remove).toContain("libmp3lame");
  });

  it("builds trimmed joiner graphs with pause, crossfade, and optional normalization", () => {
    const trims = [
      { startMs: 100, endMs: 3_000 },
      { startMs: 200, endMs: 4_000 },
    ];
    const pause = buildAdvancedJoinerArgs(
      ["one.wav", "two.wav"],
      "joined.wav",
      trims,
      "pause",
      500,
      true,
      "wav",
    );
    const pauseGraph = pause[pause.indexOf("-filter_complex") + 1];
    expect(pauseGraph).toContain("anullsrc=");
    expect(pauseGraph).toContain("loudnorm=");
    expect(pauseGraph).toContain("atrim=start=0.100:end=3.000");

    const crossfade = buildAdvancedJoinerArgs(
      ["one.wav", "two.wav"],
      "joined.flac",
      trims,
      "crossfade",
      750,
      false,
      "flac",
    );
    expect(crossfade[crossfade.indexOf("-filter_complex") + 1]).toContain("acrossfade=d=0.750");
  });
});

describe("reconstruction measurement", () => {
  it("reports an effectively silent error for an identical stem", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "audiotool-reconstruction-"));
    try {
      const source = resolve(root, "source.wav");
      const stem = resolve(root, "stem.wav");
      await runProcess(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=0.5",
          "-c:a",
          "pcm_s16le",
          source,
        ],
        { timeoutMs: 20_000 },
      );
      await copyFile(source, stem);
      const errorDb = await measureReconstructionErrorDb(source, [stem]);
      expect(errorDb).toBeLessThanOrEqual(-90);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("waveform extraction", () => {
  it("returns a compact, bounded peak envelope", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "audiotool-waveform-"));
    try {
      const source = resolve(root, "source.wav");
      await runProcess(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=220:duration=0.5",
          "-c:a",
          "pcm_s16le",
          source,
        ],
        { timeoutMs: 20_000 },
      );
      const peaks = await extractWaveformPeaks(source, 128);
      expect(peaks).toHaveLength(128);
      expect(Math.max(...peaks)).toBeGreaterThan(0);
      expect(peaks.every((value) => value >= 0 && value <= 1)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
