import { describe, expect, it } from "vitest";

import { createClickPatternWav, guideCueTimeMs } from "./guide-track-service.js";

describe("guide-track timing", () => {
  it("maps musical bars and beats to absolute song time", () => {
    expect(guideCueTimeMs({ bar: 1, beat: 1 }, 120, 4)).toBe(0);
    expect(guideCueTimeMs({ bar: 1, beat: 3 }, 120, 4)).toBe(1_000);
    expect(guideCueTimeMs({ bar: 2, beat: 1 }, 120, 4)).toBe(2_000);
    expect(guideCueTimeMs({ bar: 3, beat: 4 }, 90, 6)).toBe(10_000);
  });
});

describe("click-track waveform", () => {
  it("creates valid mono PCM WAV data with a stronger downbeat", () => {
    const wav = createClickPatternWav(120, 4);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);

    const peak = (firstFrame: number, lastFrame: number) => {
      let maximum = 0;
      for (let frame = firstFrame; frame < lastFrame; frame += 1) {
        maximum = Math.max(maximum, Math.abs(wav.readInt16LE(44 + frame * 2)));
      }
      return maximum;
    };
    const framesPerBeat = 12_000;
    const downbeatPeak = peak(0, 1_320);
    const regularBeatPeak = peak(framesPerBeat, framesPerBeat + 1_320);
    expect(downbeatPeak).toBeGreaterThan(regularBeatPeak * 1.4);
  });
});
