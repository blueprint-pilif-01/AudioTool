import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { runProcess } from "@audiotool/audio-engine";

import type { ApiContext } from "./types.js";

export function registerHealthRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/health", () => ({
    status: "ok",
    service: "audiotool-api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/ml/capabilities", async () => ({
    capabilities: await context.provider.getCapabilities(),
  }));

  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {
      postgres: { ok: false },
      ffmpeg: { ok: false },
      storage: { ok: false },
      ml: { ok: false, detail: context.provider.name },
      queue: { ok: false, detail: context.config.QUEUE_MODE },
    };
    await Promise.all([
      context.db
        .execute(sql`select 1 as ready`)
        .then(() => {
          checks.postgres = { ok: true };
        })
        .catch((error: unknown) => {
          checks.postgres = {
            ok: false,
            detail: error instanceof Error ? error.message : "Database unavailable",
          };
        }),
      runProcess(context.config.FFMPEG_PATH, ["-version"], { timeoutMs: 5_000 })
        .then(() => {
          checks.ffmpeg = { ok: true };
        })
        .catch((error: unknown) => {
          checks.ffmpeg = {
            ok: false,
            detail: error instanceof Error ? error.message : "FFmpeg unavailable",
          };
        }),
      context.storage
        .initialize()
        .then(() => {
          checks.storage = { ok: true };
        })
        .catch((error: unknown) => {
          checks.storage = {
            ok: false,
            detail: error instanceof Error ? error.message : "Storage unavailable",
          };
        }),
      context.provider
        .checkHealth()
        .then((health) => {
          checks.ml = health;
        })
        .catch((error: unknown) => {
          checks.ml = {
            ok: false,
            detail: error instanceof Error ? error.message : "ML provider unavailable",
          };
        }),
      context.jobProcessor.checkHealth().then((health) => {
        checks.queue = health;
      }),
    ]);
    const ready = Object.values(checks).every((check) => check.ok);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
