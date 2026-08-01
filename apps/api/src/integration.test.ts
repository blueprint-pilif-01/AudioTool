import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { runProcess } from "@audiotool/audio-engine";
import { loadConfig } from "@audiotool/config";
import type {
  ApiAudioAsset,
  ApiJob,
  ApiProject,
  ApiRecentJob,
  GeneratedProjectTrack,
  GuideVoice,
  InstrumentDetection,
  VocalBreakdownAnalysis,
  VocalBreakdownTrack,
} from "@audiotool/contracts";
import {
  audioAssets,
  createDatabase,
  mixSessions,
  projects,
  separationJobs,
  stems,
} from "@audiotool/database";

import { buildApp } from "./app.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration("AudioTool API PostgreSQL workflow", () => {
  let root = "";
  let baseUrl = "";
  let app: Awaited<ReturnType<typeof buildApp>>;
  let controlDatabase: ReturnType<typeof createDatabase>;
  let createdProjectId = "";

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), "audiotool-api-test-"));
    const migrationDatabase = createDatabase(testDatabaseUrl!);
    try {
      await migrate(migrationDatabase.db, {
        migrationsFolder: resolve(import.meta.dirname, "../../../packages/database/drizzle"),
      });
    } finally {
      await migrationDatabase.pool.end();
    }
    controlDatabase = createDatabase(testDatabaseUrl!);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl!,
      API_HOST: "127.0.0.1",
      API_PORT: "3000",
      WEB_ORIGIN: "http://localhost:5173",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_ROOT: resolve(root, "storage"),
      TEMP_ROOT: resolve(root, "tmp"),
      MAX_UPLOAD_BYTES: "10485760",
      QUEUE_MODE: "inline",
      REDIS_URL: "redis://localhost:6379",
      ML_PROVIDER: "mock",
      ML_WORKER_URL: "http://localhost:8000",
      ML_REQUEST_TIMEOUT_MS: "120000",
      FFMPEG_PATH: "ffmpeg",
      FFPROBE_PATH: "ffprobe",
      TRUST_PROXY: "false",
    });
    app = await buildApp({ config, logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Test API did not bind a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (createdProjectId) {
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
        ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  }

  async function waitForJob(jobId: string, expected: string[]): Promise<ApiJob> {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const result = await json<{ job: ApiJob }>(`/api/jobs/${jobId}`);
      if (expected.includes(result.job.status)) return result.job;
      if (result.job.status === "failed") throw new Error(result.job.errorMessage ?? "Job failed");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(`Job ${jobId} did not reach ${expected.join(" or ")}.`);
  }

  it("persists a dynamic mock separation and mixer session", async () => {
    const fixture = resolve(root, "generated-fixture.wav");
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
        "sine=frequency=440:duration=2",
        "-c:a",
        "pcm_s16le",
        fixture,
      ],
      { timeoutMs: 20_000 },
    );
    const created = await json<{ project: ApiProject }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Generated integration fixture" }),
    });
    createdProjectId = created.project.id;
    const upload = new FormData();
    upload.append(
      "file",
      new Blob([await readFile(fixture)], { type: "audio/wav" }),
      "fixture.wav",
    );
    const uploadResponse = await fetch(`${baseUrl}/api/projects/${created.project.id}/audio`, {
      method: "POST",
      body: upload,
    });
    expect(uploadResponse.status).toBe(201);
    const uploaded = (await uploadResponse.json()) as { asset: { id: string } };
    const duplicateUpload = new FormData();
    duplicateUpload.append(
      "file",
      new Blob([await readFile(fixture)], { type: "audio/wav" }),
      "fixture-copy.wav",
    );
    const duplicateResponse = await fetch(`${baseUrl}/api/projects/${created.project.id}/audio`, {
      method: "POST",
      body: duplicateUpload,
    });
    expect(duplicateResponse.status).toBe(200);
    const duplicate = (await duplicateResponse.json()) as {
      asset: { id: string };
      deduplicated: boolean;
    };
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.asset.id).toBe(uploaded.asset.id);

    const [detectionStart, duplicateDetectionStart] = await Promise.all([
      json<{ job: ApiJob }>(`/api/projects/${created.project.id}/detect-instruments`, {
        method: "POST",
        body: "{}",
      }),
      json<{ job: ApiJob }>(`/api/projects/${created.project.id}/detect-instruments`, {
        method: "POST",
        body: "{}",
      }),
    ]);
    expect(duplicateDetectionStart.job.id).toBe(detectionStart.job.id);
    await waitForJob(detectionStart.job.id, ["awaiting_confirmation"]);
    const detectionResult = await json<{ detections: InstrumentDetection[] }>(
      `/api/projects/${created.project.id}/detections`,
    );
    expect(detectionResult.detections.length).toBeGreaterThan(4);
    detectionResult.detections[0]!.displayLabel = "Primary vocal";
    const savedDetections = await json<{ detections: InstrumentDetection[] }>(
      `/api/projects/${created.project.id}/detections`,
      {
        method: "PATCH",
        body: JSON.stringify({ detections: detectionResult.detections }),
      },
    );
    expect(savedDetections.detections[0]?.displayLabel).toBe("Primary vocal");

    const separationRequest = {
      method: "POST",
      body: JSON.stringify({
        mode: "auto",
        detectionIds: savedDetections.detections
          .filter((detection) => detection.selected)
          .map((detection) => detection.id),
      }),
    } satisfies RequestInit;
    const [separationStart, duplicateSeparationStart] = await Promise.all([
      json<{ job: ApiJob }>(
        `/api/projects/${created.project.id}/separation-jobs`,
        separationRequest,
      ),
      json<{ job: ApiJob }>(`/api/projects/${created.project.id}/separation-jobs`, {
        ...separationRequest,
      }),
    ]);
    expect(duplicateSeparationStart.job.id).toBe(separationStart.job.id);
    await waitForJob(separationStart.job.id, ["completed"]);
    const recentJobs = await json<{ jobs: ApiRecentJob[] }>("/api/jobs?limit=1");
    expect(recentJobs.jobs).toHaveLength(1);
    expect(recentJobs.jobs[0]).toMatchObject({
      id: separationStart.job.id,
      projectId: created.project.id,
      projectName: "Generated integration fixture",
      projectStatus: "ready",
      status: "completed",
    });
    const stems = await json<{ stems: Array<{ canonicalLabel: string }> }>(
      `/api/projects/${created.project.id}/stems`,
    );
    expect(stems.stems.length).toBeGreaterThan(4);
    expect(stems.stems.some((stem) => stem.canonicalLabel === "other")).toBe(true);

    const mixResult = await json<{
      mix: {
        name: string;
        masterSettings: { volumeDb: number };
        tracks: Array<Record<string, unknown> & { volumeDb: number }>;
      };
    }>(`/api/projects/${created.project.id}/mix`);
    expect(mixResult.mix.tracks).toHaveLength(stems.stems.length);

    const guideSetup = await json<{
      durationMs: number;
      voices: GuideVoice[];
      tracks: GeneratedProjectTrack[];
    }>(`/api/projects/${created.project.id}/guide-tracks`);
    expect(guideSetup.durationMs).toBe(2_000);
    const femaleVoice =
      guideSetup.voices.find((voice) => voice.gender === "Female") ?? guideSetup.voices[0];
    expect(femaleVoice).toBeDefined();
    const voicePreview = await fetch(
      `${baseUrl}/api/projects/${created.project.id}/guide-voice-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceName: femaleVoice!.name,
          speechRate: 0,
          text: "Chorus",
        }),
      },
    );
    expect(voicePreview.status).toBe(200);
    expect(voicePreview.headers.get("content-type")).toContain("audio/wav");
    expect((await voicePreview.arrayBuffer()).byteLength).toBeGreaterThan(44);
    const generated = await json<{ tracks: GeneratedProjectTrack[] }>(
      `/api/projects/${created.project.id}/guide-tracks`,
      {
        method: "POST",
        body: JSON.stringify({
          bpm: 120,
          beatsPerBar: 4,
          beatUnit: 4,
          createGuide: true,
          createClick: true,
          voiceName: femaleVoice!.name,
          speechRate: 0,
          guideVolumeDb: -3,
          clickVolumeDb: -9,
          cues: [{ id: "intro", bar: 1, beat: 1, text: "Intro" }],
        }),
      },
    );
    expect(generated.tracks.map((track) => track.type).sort()).toEqual(["click", "guide"]);
    expect(generated.tracks.every((track) => track.asset.durationMs === 2_000)).toBe(true);
    const mixWithGuide = await json<{
      mix: { tracks: Array<{ trackType: string; label: string }> };
    }>(`/api/projects/${created.project.id}/mix`);
    expect(mixWithGuide.mix.tracks).toHaveLength(stems.stems.length + 2);
    expect(mixWithGuide.mix.tracks.some((track) => track.trackType === "guide")).toBe(true);
    expect(mixWithGuide.mix.tracks.some((track) => track.trackType === "click")).toBe(true);

    const vocalSetup = await json<{
      durationMs: number;
      analysis: VocalBreakdownAnalysis | null;
      tracks: VocalBreakdownTrack[];
    }>(`/api/projects/${created.project.id}/vocal-breakdown`);
    expect(vocalSetup.durationMs).toBe(2_000);
    expect(vocalSetup.analysis).toBeNull();
    const vocalBreakdown = await json<{
      analysis: VocalBreakdownAnalysis;
      tracks: VocalBreakdownTrack[];
    }>(`/api/projects/${created.project.id}/vocal-breakdown`, {
      method: "POST",
      body: JSON.stringify({ parts: ["melody", "soprano", "alto", "tenor", "bass"] }),
    });
    expect(vocalBreakdown.analysis.experimental).toBe(true);
    expect(vocalBreakdown.analysis.methodology).toBe("dominant-pitch-register-gating");
    expect(vocalBreakdown.tracks).toHaveLength(5);
    expect(vocalBreakdown.tracks.every((track) => track.asset.durationMs === 2_000)).toBe(true);
    const mixWithLearningTracks = await json<{
      mix: { tracks: Array<{ trackType: string; vocalPart?: string }> };
    }>(`/api/projects/${created.project.id}/mix`);
    expect(mixWithLearningTracks.mix.tracks).toHaveLength(stems.stems.length + 7);
    expect(
      mixWithLearningTracks.mix.tracks.some(
        (track) => track.trackType === "vocal_breakdown" && track.vocalPart === "alto",
      ),
    ).toBe(true);

    mixResult.mix.tracks = (
      await json<{ mix: { tracks: typeof mixResult.mix.tracks } }>(
        `/api/projects/${created.project.id}/mix`,
      )
    ).mix.tracks;
    mixResult.mix.tracks[0]!.volumeDb = -4.5;
    await json(`/api/projects/${created.project.id}/mix`, {
      method: "PUT",
      body: JSON.stringify({
        name: mixResult.mix.name,
        masterSettings: mixResult.mix.masterSettings,
        tracks: mixResult.mix.tracks,
      }),
    });
    const reloaded = await json<{ mix: { tracks: Array<{ volumeDb: number }> } }>(
      `/api/projects/${created.project.id}/mix`,
    );
    expect(reloaded.mix.tracks[0]?.volumeDb).toBe(-4.5);

    for (const format of ["mp3", "flac"] as const) {
      const render = await json<{ job: ApiJob }>(`/api/projects/${created.project.id}/render`, {
        method: "POST",
        body: JSON.stringify({ format }),
      });
      await waitForJob(render.job.id, ["completed"]);
    }
    const exports = await json<{ exports: ApiAudioAsset[] }>(
      `/api/projects/${created.project.id}/exports`,
    );
    expect(exports.exports.some((asset) => asset.originalFilename.endsWith(".mp3"))).toBe(true);
    expect(exports.exports.some((asset) => asset.originalFilename.endsWith(".flac"))).toBe(true);

    const completedCancel = await fetch(`${baseUrl}/api/jobs/${separationStart.job.id}/cancel`, {
      method: "POST",
    });
    expect(completedCancel.status).toBe(409);

    const [queued] = await controlDatabase.db
      .insert(separationJobs)
      .values({
        projectId: created.project.id,
        mode: "auto",
        status: "queued",
        progress: 0,
        currentStage: "queued",
        provider: "mock",
        options: { task: "separate" },
      })
      .returning({ id: separationJobs.id });
    expect(queued).toBeDefined();
    const cancelQueued = await fetch(`${baseUrl}/api/jobs/${queued!.id}/cancel`, {
      method: "POST",
    });
    expect(cancelQueued.status).toBe(202);
    const cancelled = await json<{ job: ApiJob }>(`/api/jobs/${queued!.id}`);
    expect(cancelled.job.status).toBe("cancelled");

    const [failed] = await controlDatabase.db
      .insert(separationJobs)
      .values({
        projectId: created.project.id,
        mode: "auto",
        status: "failed",
        progress: 40,
        currentStage: "separating_piano",
        provider: "mock",
        errorCode: "SYNTHETIC_FAILURE",
        errorMessage: "Synthetic retry fixture",
        options: { task: "separate" },
      })
      .returning({ id: separationJobs.id });
    expect(failed).toBeDefined();
    const retry = await json<{ job: ApiJob }>(`/api/jobs/${failed!.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ canonicalLabels: ["piano"] }),
    });
    await waitForJob(retry.job.id, ["completed"]);
    const mixAfterRetry = await json<{ mix: { tracks: Array<{ label: string }> } }>(
      `/api/projects/${created.project.id}/mix`,
    );
    expect(mixAfterRetry.mix.tracks).toHaveLength(stems.stems.length + 7);
    expect(mixAfterRetry.mix.tracks.some((track) => track.label === "Piano")).toBe(true);
    expect(mixAfterRetry.mix.tracks.some((track) => track.label === "Guide cues")).toBe(true);
    expect(mixAfterRetry.mix.tracks.some((track) => track.label === "Click track")).toBe(true);

    const deleted = await fetch(`${baseUrl}/api/projects/${created.project.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const hidden = await fetch(`${baseUrl}/api/projects/${created.project.id}`);
    expect(hidden.status).toBe(404);
  }, 120_000);
});
