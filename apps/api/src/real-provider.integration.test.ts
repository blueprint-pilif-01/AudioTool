import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadConfig } from "@audiotool/config";
import type { ApiJob, ApiProject, InstrumentDetection } from "@audiotool/contracts";
import { audioAssets, createDatabase, mixSessions, projects, stems } from "@audiotool/database";

import { buildApp } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.REAL_ML_WORKER_URL;
const fixturePath = process.env.REAL_ML_AUDIO_FIXTURE;
const integration = databaseUrl && workerUrl && fixturePath ? describe : describe.skip;
const internalApiKey = "real-provider-integration-key-0123456789";
const internalHeaders = {
  Authorization: `Bearer ${internalApiKey}`,
  "X-AudioTool-User-Id": "987654321000000001",
  "X-AudioTool-User-Role": "admin",
};

integration("AudioTool real ML provider workflow", () => {
  let root = "";
  let baseUrl = "";
  let app: Awaited<ReturnType<typeof buildApp>>;
  let controlDatabase: ReturnType<typeof createDatabase>;
  let createdProjectId = "";

  beforeAll(async () => {
    root = resolve(tmpdir(), `audiotool-real-provider-${crypto.randomUUID()}`);
    const migrationDatabase = createDatabase(databaseUrl!);
    try {
      await migrate(migrationDatabase.db, {
        migrationsFolder: resolve(import.meta.dirname, "../../../packages/database/drizzle"),
      });
    } finally {
      await migrationDatabase.pool.end();
    }
    controlDatabase = createDatabase(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl!,
      API_HOST: "127.0.0.1",
      API_PORT: "3000",
      WEB_ORIGIN: "http://localhost:5173",
      INTERNAL_API_KEY: internalApiKey,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_ROOT: resolve(root, "storage"),
      TEMP_ROOT: resolve(root, "tmp"),
      MAX_UPLOAD_BYTES: "104857600",
      MAX_AUDIO_DURATION_MS: "120000",
      QUEUE_MODE: "inline",
      REDIS_URL: "redis://localhost:6379",
      ML_PROVIDER: "demucs_http",
      ML_WORKER_URL: workerUrl!,
      ML_REQUEST_TIMEOUT_MS: "1800000",
      FFMPEG_PATH: "ffmpeg",
      FFPROBE_PATH: "ffprobe",
      TRUST_PROXY: "false",
    });
    app = await buildApp({ config, logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Real-provider test API did not bind a TCP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (createdProjectId && controlDatabase) {
      await controlDatabase.db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({ sourceAudioId: null })
          .where(eq(projects.id, createdProjectId));
        await tx.delete(mixSessions).where(eq(mixSessions.projectId, createdProjectId));
        await tx.delete(stems).where(eq(stems.projectId, createdProjectId));
        await tx.delete(audioAssets).where(eq(audioAssets.projectId, createdProjectId));
        await tx.delete(projects).where(eq(projects.id, createdProjectId));
      });
    }
    await controlDatabase?.pool.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...internalHeaders,
        ...(init?.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  async function waitForJob(jobId: string, expected: string[]): Promise<ApiJob> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const result = await json<{ job: ApiJob }>(`/api/jobs/${jobId}`);
      if (expected.includes(result.job.status)) return result.job;
      if (result.job.status === "failed") {
        throw new Error(result.job.errorMessage ?? "Real-provider job failed");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error(`Job ${jobId} did not reach ${expected.join(" or ")}.`);
  }

  it("detects and separates through Demucs while preserving worker metadata", async () => {
    const capabilities = await json<{
      capabilities: {
        mock: boolean;
        modelName: string;
        modelVersion: string;
        supportedLabels: string[];
      };
    }>("/api/ml/capabilities");
    expect(capabilities.capabilities).toMatchObject({
      mock: false,
      modelName: "htdemucs_6s",
      modelVersion: "demucs-4.1.0",
    });
    expect(capabilities.capabilities.supportedLabels).toEqual(
      expect.arrayContaining([
        "vocals",
        "drums",
        "bass_guitar",
        "guitar",
        "piano",
        "other",
        "instrumental",
      ]),
    );

    const created = await json<{ project: ApiProject }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Generated real-provider verification" }),
    });
    createdProjectId = created.project.id;
    const upload = new FormData();
    upload.append(
      "file",
      new Blob([await readFile(fixturePath!)], { type: "audio/wav" }),
      "generated-demucs-benchmark.wav",
    );
    const uploadResponse = await fetch(`${baseUrl}/api/projects/${createdProjectId}/audio`, {
      method: "POST",
      body: upload,
      headers: internalHeaders,
    });
    expect(uploadResponse.status).toBe(201);

    const detectionStart = await json<{ job: ApiJob }>(
      `/api/projects/${createdProjectId}/detect-instruments`,
      { method: "POST", body: "{}" },
    );
    await waitForJob(detectionStart.job.id, ["awaiting_confirmation"]);
    const detected = await json<{ detections: InstrumentDetection[] }>(
      `/api/projects/${createdProjectId}/detections`,
    );
    expect(detected.detections.length).toBeGreaterThanOrEqual(2);
    expect(detected.detections.some((item) => item.modelName === "htdemucs_6s")).toBe(true);
    expect(
      detected.detections.every((item) =>
        item.modelName === "htdemucs_6s"
          ? item.modelVersion === "demucs-4.1.0"
          : item.modelName === "residual-texture-split" && item.modelVersion === "1.0.0",
      ),
    ).toBe(true);

    const renamedDetection = detected.detections.find((item) => item.modelName === "htdemucs_6s")!;
    renamedDetection.displayLabel = "Verified real stem";
    const saved = await json<{ detections: InstrumentDetection[] }>(
      `/api/projects/${createdProjectId}/detections`,
      {
        method: "PATCH",
        body: JSON.stringify({ detections: detected.detections }),
      },
    );
    expect(saved.detections.find((item) => item.displayLabel === "Verified real stem")).toMatchObject({
      displayLabel: "Verified real stem",
      modelName: "htdemucs_6s",
      modelVersion: "demucs-4.1.0",
    });

    const separationStart = await json<{ job: ApiJob }>(
      `/api/projects/${createdProjectId}/separation-jobs`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "auto",
          detectionIds: saved.detections
            .filter((detection) => detection.selected)
            .map((detection) => detection.id),
        }),
      },
    );
    await waitForJob(separationStart.job.id, ["completed"]);

    const persistedStems = await controlDatabase.db
      .select({
        canonicalLabel: stems.canonicalLabel,
        isResidual: stems.isResidual,
        processingMetadata: stems.processingMetadata,
      })
      .from(stems)
      .where(eq(stems.projectId, createdProjectId));
    const expectedLabels = new Set(
      saved.detections.filter((item) => item.selected).map((item) => item.canonicalLabel),
    );
    const usesTextureSplit = expectedLabels.has("synthesizer") || expectedLabels.has("percussion");
    if (usesTextureSplit) {
      expectedLabels.delete("other");
      expectedLabels.add("synthesizer");
      expectedLabels.add("percussion");
    } else {
      expectedLabels.add("other");
    }
    expect(persistedStems.map((stem) => stem.canonicalLabel).sort()).toEqual(
      [...expectedLabels].sort(),
    );
    if (usesTextureSplit) {
      expect(persistedStems.some((stem) => stem.canonicalLabel === "other")).toBe(false);
    } else {
      expect(persistedStems.some((stem) => stem.canonicalLabel === "other" && stem.isResidual)).toBe(
        true,
      );
    }
    expect(
      persistedStems.every((stem) => {
        const expectedModel = ["synthesizer", "percussion"].includes(stem.canonicalLabel)
          ? ["residual-texture-split", "1.0.0"]
          : ["htdemucs_6s", "demucs-4.1.0"];
        return (
          stem.processingMetadata.modelName === expectedModel[0] &&
          stem.processingMetadata.modelVersion === expectedModel[1] &&
          stem.processingMetadata.mock === false
        );
      }),
    ).toBe(true);

    const quickStart = await json<{ job: ApiJob }>(
      `/api/projects/${createdProjectId}/separation-jobs`,
      { method: "POST", body: JSON.stringify({ mode: "quick" }) },
    );
    await waitForJob(quickStart.job.id, ["completed"]);
    const quickStems = await controlDatabase.db
      .select({
        canonicalLabel: stems.canonicalLabel,
        processingMetadata: stems.processingMetadata,
      })
      .from(stems)
      .where(eq(stems.jobId, quickStart.job.id));
    expect(quickStems.map((stem) => stem.canonicalLabel).sort()).toEqual([
      "instrumental",
      "vocals",
    ]);
    expect(
      quickStems.every(
        (stem) =>
          stem.processingMetadata.modelName === "htdemucs_ft" &&
          stem.processingMetadata.modelVersion === "demucs-4.1.0" &&
          stem.processingMetadata.mock === false,
      ),
    ).toBe(true);
  }, 300_000);
});
