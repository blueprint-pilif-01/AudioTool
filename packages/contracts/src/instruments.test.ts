import { describe, expect, it } from "vitest";

import { mlProviderCapabilitiesSchema, normalizeInstrumentLabel } from "./index.js";

describe("normalizeInstrumentLabel", () => {
  it.each([
    ["drum kit", "drums"],
    ["ELECTRIC_GUITAR", "electric_guitar"],
    ["sax", "saxophone"],
    ["  synth-bass  ", "synth_bass"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeInstrumentLabel(input)).toBe(expected);
  });

  it("returns null for unknown labels", () => {
    expect(normalizeInstrumentLabel("glass harmonica")).toBeNull();
  });
});

describe("mlProviderCapabilitiesSchema", () => {
  it("rejects provider labels outside the shared taxonomy", () => {
    const result = mlProviderCapabilitiesSchema.safeParse({
      provider: "external",
      modelName: "example",
      modelVersion: "1",
      supportedLabels: ["imaginary_instrument"],
      dynamicStemCount: true,
      limitations: [],
      mock: false,
    });
    expect(result.success).toBe(false);
  });
});
