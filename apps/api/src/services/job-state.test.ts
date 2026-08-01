import { describe, expect, it } from "vitest";

import { assertJobTransition, canCancelJob, isTerminalJobStatus } from "./job-state.js";

describe("job state machine", () => {
  it("allows the detection, separation, and render paths", () => {
    expect(() => assertJobTransition("queued", "detecting", 0, 10)).not.toThrow();
    expect(() => assertJobTransition("detecting", "awaiting_confirmation", 35, 100)).not.toThrow();
    expect(() => assertJobTransition("queued", "separating", 0, 5)).not.toThrow();
    expect(() => assertJobTransition("separating", "rendering", 80, 90)).not.toThrow();
    expect(() => assertJobTransition("rendering", "completed", 90, 100)).not.toThrow();
  });

  it("rejects terminal transitions and progress regression", () => {
    expect(() => assertJobTransition("completed", "rendering", 100, 10)).toThrow(
      "Invalid job transition",
    );
    expect(() => assertJobTransition("detecting", "detecting", 35, 10)).toThrow("cannot decrease");
  });

  it("only cancels active work", () => {
    expect(canCancelJob("queued")).toBe(true);
    expect(canCancelJob("separating")).toBe(true);
    expect(canCancelJob("awaiting_confirmation")).toBe(false);
    expect(canCancelJob("completed")).toBe(false);
    expect(isTerminalJobStatus("cancelled")).toBe(true);
  });
});
