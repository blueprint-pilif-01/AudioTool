import type { JobStatus } from "@audiotool/contracts";

const terminalStatuses = new Set<JobStatus>(["completed", "failed", "cancelled"]);

const allowedTransitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["detecting", "separating", "rendering", "failed", "cancelled"]),
  detecting: new Set(["detecting", "awaiting_confirmation", "failed", "cancelled"]),
  awaiting_confirmation: new Set(),
  separating: new Set(["separating", "rendering", "failed", "cancelled"]),
  rendering: new Set(["rendering", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function isTerminalJobStatus(status: JobStatus): boolean {
  return terminalStatuses.has(status);
}

export function canCancelJob(status: JobStatus): boolean {
  return !terminalStatuses.has(status) && status !== "awaiting_confirmation";
}

export function assertJobTransition(
  from: JobStatus,
  to: JobStatus,
  previousProgress: number,
  nextProgress: number,
): void {
  if (!allowedTransitions[from].has(to)) {
    throw new Error(`Invalid job transition from ${from} to ${to}.`);
  }
  if (nextProgress < previousProgress && to !== "failed" && to !== "cancelled") {
    throw new Error(`Job progress cannot decrease from ${previousProgress} to ${nextProgress}.`);
  }
}
