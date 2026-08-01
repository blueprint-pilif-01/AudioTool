import { expect, test, type Page, type Route } from "@playwright/test";
import { instrumentLabels, type ApiJob } from "@audiotool/contracts";

import type { ApiMix } from "../src/lib/api";

function silentWav(durationSeconds = 2): Buffer {
  const sampleRate = 8_000;
  const dataLength = sampleRate * durationSeconds * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

const wavHeader = silentWav();

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "E2E instrument session",
  status: "draft",
  sourceAudioId: null as string | null,
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
};

const resumableJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let projectJobs: ApiJob[] = [];

const defaultDetections = [
  ["vocals", "Vocals", 0.97],
  ["drums", "Drums", 0.92],
  ["bass_guitar", "Bass guitar", 0.86],
  ["electric_guitar", "Electric guitar", 0.79],
  ["piano", "Piano", 0.72],
  ["strings", "Strings", 0.64],
].map(([canonicalLabel, displayLabel, confidence], index) => ({
  id: `22222222-2222-4222-8222-22222222222${index}`,
  canonicalLabel,
  displayLabel,
  confidence,
  detectedSpans: [{ startMs: 0, endMs: 60_000 }],
  selected: true,
  manuallyAdded: false,
  modelName: "deterministic-development-provider",
  modelVersion: "1.0.0",
}));
let detections = defaultDetections.map((detection) => ({ ...detection }));

let providerCapabilities = {
  provider: "mock",
  modelName: "deterministic-development-provider",
  modelVersion: "1.0.0",
  supportedLabels: [...instrumentLabels],
  dynamicStemCount: true,
  limitations: ["Mock output is test audio."],
  mock: true,
};

const stems = [
  ...detections,
  {
    id: "residual-detection",
    canonicalLabel: "other",
    displayLabel: "Other / residual",
    confidence: 1,
  },
].map((item, index) => ({
  id: `33333333-3333-4333-8333-33333333333${index}`,
  projectId: project.id,
  jobId: "55555555-5555-4555-8555-555555555555",
  audioAssetId: `44444444-4444-4444-8444-44444444444${index}`,
  canonicalLabel: item.canonicalLabel,
  displayLabel: item.displayLabel,
  confidence: item.confidence,
  isResidual: item.canonicalLabel === "other",
  streamUrl: `/api/audio/44444444-4444-4444-8444-44444444444${index}/stream`,
  downloadUrl: `/api/stems/33333333-3333-4333-8333-33333333333${index}/download`,
}));

let generatedTracks: Array<{
  type: "guide" | "click";
  asset: {
    id: string;
    projectId: string;
    kind: "preview";
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    durationMs: number;
    sampleRate: number;
    channels: number;
    codec: string;
    streamUrl: string;
  };
  settings: {
    bpm: number;
    beatsPerBar: number;
    beatUnit: number;
    voiceName?: string;
    speechRate?: number;
    cues?: Array<{ id: string; bar: number; beat: number; text: string }>;
  };
}> = [];

let vocalBreakdownTracks: Array<{
  part: "melody" | "soprano" | "alto" | "tenor" | "bass";
  displayName: string;
  asset: {
    id: string;
    projectId: string;
    kind: "preview";
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    durationMs: number;
    sampleRate: number;
    channels: number;
    codec: string;
    streamUrl: string;
  };
  confidence: number;
  coverage: number;
}> = [];

let mix: ApiMix = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId: project.id,
  name: "Main mix",
  masterSettings: { volumeDb: 0 },
  tracks: stems.map((stem, index) => ({
    id: `77777777-7777-4777-8777-77777777777${index}`,
    stemId: stem.id,
    audioAssetId: stem.audioAssetId,
    orderIndex: index,
    startMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    enabled: true,
    fadeInMs: 0,
    fadeOutMs: 0,
    label: String(stem.displayLabel),
    trackType: "stem",
    durationMs: 60_000,
    streamUrl: stem.streamUrl,
  })),
};

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installMockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.includes("/stream") || path.includes("/playback")) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: wavHeader });
    }
    if (path.endsWith("/waveform") && method === "GET") {
      return json(route, {
        peaks: Array.from({ length: 256 }, (_, index) => 0.15 + (index % 13) / 16),
        durationMs: 60_000,
      });
    }
    if (path === "/api/ml/capabilities" && method === "GET") {
      return json(route, { capabilities: providerCapabilities });
    }
    if (path === "/api/projects" && method === "GET") {
      return json(route, { projects: [project] });
    }
    if (path === "/api/projects" && method === "POST") {
      const body = request.postDataJSON() as { name: string };
      project.name = body.name;
      return json(route, { project }, 201);
    }
    if (path === `/api/projects/${project.id}/audio` && method === "POST") {
      project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
      return json(
        route,
        {
          asset: {
            id: project.sourceAudioId,
            projectId: project.id,
            kind: "source",
            originalFilename: "fixture.wav",
            mimeType: "audio/wav",
            sizeBytes: wavHeader.length,
            durationMs: 60_000,
            sampleRate: 44_100,
            channels: 2,
            codec: "pcm_s16le",
            streamUrl: `/api/audio/${project.sourceAudioId}/stream`,
          },
        },
        201,
      );
    }
    if (path === `/api/projects/${project.id}` && method === "GET") return json(route, { project });
    if (path === `/api/audio/${project.sourceAudioId}` && method === "GET") {
      return json(route, {
        asset: {
          id: project.sourceAudioId,
          projectId: project.id,
          kind: "source",
          originalFilename: "fixture.wav",
          mimeType: "audio/wav",
          sizeBytes: wavHeader.length,
          durationMs: 60_000,
          sampleRate: 44_100,
          channels: 2,
          codec: "pcm_s16le",
          streamUrl: `/api/audio/${project.sourceAudioId}/stream`,
        },
      });
    }
    if (path.endsWith("/detect-instruments") && method === "POST") {
      expect(request.headers()["content-type"]).toContain("application/json");
      expect(request.postData()).toBe("{}");
      project.status = "analyzing";
      return json(
        route,
        {
          job: {
            id: "99999999-9999-4999-8999-999999999999",
            projectId: project.id,
            mode: "auto",
            status: "detecting",
            progress: 10,
            currentStage: "preparing",
            provider: "mock",
            errorCode: null,
            errorMessage: null,
            queuedAt: project.createdAt,
            startedAt: project.createdAt,
            finishedAt: null,
          },
        },
        202,
      );
    }
    if (path === "/api/jobs/99999999-9999-4999-8999-999999999999/events") {
      project.status = "awaiting_confirmation";
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: progress\ndata: ${JSON.stringify({
          jobId: "99999999-9999-4999-8999-999999999999",
          status: "awaiting_confirmation",
          progress: 100,
          stage: "awaiting_confirmation",
          message: "Detected 6 instrument categories.",
          timestamp: project.updatedAt,
        })}\n\n`,
      });
    }
    if (path.endsWith("/detections") && method === "GET") return json(route, { detections });
    if (path.endsWith("/detections") && method === "PATCH") {
      detections = (request.postDataJSON() as { detections: typeof detections }).detections;
      return json(route, { detections });
    }
    if (path.endsWith("/separation-jobs") && method === "POST") {
      project.status = "separating";
      return json(
        route,
        {
          job: {
            id: "55555555-5555-4555-8555-555555555555",
            projectId: project.id,
            mode: "auto",
            status: "separating",
            progress: 10,
            currentStage: "preparing",
            provider: "mock",
            errorCode: null,
            errorMessage: null,
            queuedAt: project.createdAt,
            startedAt: project.createdAt,
            finishedAt: null,
          },
        },
        202,
      );
    }
    if (path === "/api/jobs/55555555-5555-4555-8555-555555555555/events") {
      project.status = "ready";
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: progress\ndata: ${JSON.stringify({
          jobId: "55555555-5555-4555-8555-555555555555",
          status: "completed",
          progress: 100,
          stage: "completed",
          message: "Created 7 stems and opened the mixer.",
          timestamp: project.updatedAt,
        })}\n\n`,
      });
    }
    if (path === "/api/jobs/55555555-5555-4555-8555-555555555555" && method === "GET") {
      return json(route, {
        job: {
          id: "55555555-5555-4555-8555-555555555555",
          projectId: project.id,
          mode: "auto",
          status: "separating",
          progress: 10,
          currentStage: "preparing",
          provider: "mock",
          errorCode: null,
          errorMessage: null,
          queuedAt: project.createdAt,
          startedAt: project.createdAt,
          finishedAt: null,
        },
      });
    }
    if (path === "/api/jobs" && method === "GET") {
      if (projectJobs.length > 0) {
        return json(route, {
          jobs: projectJobs.map((job) => ({
            ...job,
            projectName: project.name,
            projectStatus: project.status,
          })),
        });
      }
      return json(route, {
        jobs: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            projectId: project.id,
            projectName: project.name,
            projectStatus: "ready",
            mode: "auto",
            status: "completed",
            progress: 100,
            currentStage: "completed",
            provider: "mock",
            errorCode: null,
            errorMessage: null,
            queuedAt: project.createdAt,
            startedAt: project.createdAt,
            finishedAt: project.updatedAt,
          },
        ],
      });
    }
    if (path.endsWith("/jobs") && method === "GET") return json(route, { jobs: projectJobs });
    if (path === `/api/jobs/${resumableJobId}/events`) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": active analysis remains on the backend\n\n",
      });
    }
    if (path.endsWith("/stems") && method === "GET") return json(route, { stems });
    if (path.endsWith("/guide-tracks") && method === "GET") {
      return json(route, {
        durationMs: 60_000,
        cloudTtsConfigured: false,
        neuralTtsAvailable: true,
        voices: [
          {
            name: "en-US-JennyNeural",
            displayName: "Jenny · Worship guide",
            culture: "en-US",
            gender: "Female",
            provider: "edge",
            description: "Recommended: a tight, clear US cue voice.",
          },
          {
            name: "ro-RO-AlinaNeural",
            displayName: "Alina · Ghid în română",
            culture: "ro-RO",
            gender: "Female",
            provider: "edge",
            description: "Voce neural feminină pentru indicații în română.",
          },
          {
            name: "Microsoft Zira Desktop",
            displayName: "Microsoft Zira Desktop · Offline",
            culture: "en-US",
            gender: "Female",
            provider: "system",
            description: "Offline Windows fallback voice.",
          },
        ],
        tracks: generatedTracks,
      });
    }
    if (path.endsWith("/guide-voice-preview") && method === "POST") {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: wavHeader });
    }
    if (path.endsWith("/guide-tracks") && method === "POST") {
      const body = request.postDataJSON() as {
        bpm: number;
        beatsPerBar: number;
        beatUnit: number;
        createGuide: boolean;
        createClick: boolean;
        voiceName?: string;
        speechRate: number;
        cues: Array<{ id: string; bar: number; beat: number; text: string }>;
      };
      const requestedTypes = [
        ...(body.createGuide ? (["guide"] as const) : []),
        ...(body.createClick ? (["click"] as const) : []),
      ];
      generatedTracks = [
        ...generatedTracks.filter((track) => !requestedTypes.includes(track.type)),
        ...requestedTypes.map((type, index) => ({
          type,
          asset: {
            id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
            projectId: project.id,
            kind: "preview" as const,
            originalFilename: `${type}-track.wav`,
            mimeType: "audio/wav",
            sizeBytes: 2_880_044,
            durationMs: 60_000,
            sampleRate: 24_000,
            channels: 1,
            codec: "pcm_s16le",
            streamUrl: `/api/audio/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}/stream`,
          },
          settings: {
            bpm: body.bpm,
            beatsPerBar: body.beatsPerBar,
            beatUnit: body.beatUnit,
            ...(type === "guide"
              ? {
                  voiceName: body.voiceName ?? "Microsoft Zira Desktop",
                  speechRate: body.speechRate,
                  cues: body.cues,
                }
              : {}),
          },
        })),
      ];
      mix.tracks = [
        ...mix.tracks.filter(
          (track) => !requestedTypes.includes(track.trackType as "guide" | "click"),
        ),
        ...generatedTracks.map((track, index) => ({
          id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`,
          stemId: null,
          audioAssetId: track.asset.id,
          orderIndex: stems.length + index,
          startMs: 0,
          trimStartMs: 0,
          trimEndMs: 0,
          volumeDb: track.type === "guide" ? -3 : -9,
          pan: 0,
          muted: false,
          solo: false,
          enabled: true,
          fadeInMs: 0,
          fadeOutMs: 0,
          label: track.type === "guide" ? "Guide cues" : "Click track",
          trackType: track.type,
          durationMs: track.asset.durationMs,
          streamUrl: track.asset.streamUrl,
        })),
      ];
      return json(route, { tracks: generatedTracks }, 201);
    }
    if (path.endsWith("/vocal-breakdown") && method === "GET") {
      return json(route, {
        vocalStem: stems[0],
        durationMs: 60_000,
        analysis: vocalBreakdownTracks.length
          ? {
              durationMs: 60_000,
              voicedDurationMs: 21_000,
              confidence: 0.88,
              lowestNote: "A2",
              highestNote: "G5",
              medianNote: "C4",
              notes: [
                {
                  startMs: 1_000,
                  endMs: 3_500,
                  midi: 60,
                  note: "C4",
                  frequencyHz: 261.63,
                  confidence: 0.91,
                  register: "alto",
                },
                {
                  startMs: 5_000,
                  endMs: 7_000,
                  midi: 55,
                  note: "G3",
                  frequencyHz: 196,
                  confidence: 0.86,
                  register: "tenor",
                },
              ],
              registers: [
                {
                  part: "soprano",
                  displayName: "Soprano",
                  range: "F♯4–C6",
                  coverage: 0.18,
                  confidence: 0.82,
                },
                {
                  part: "alto",
                  displayName: "Alto",
                  range: "A♯3–F4",
                  coverage: 0.42,
                  confidence: 0.9,
                },
                {
                  part: "tenor",
                  displayName: "Tenor",
                  range: "C3–A3",
                  coverage: 0.32,
                  confidence: 0.86,
                },
                {
                  part: "bass",
                  displayName: "Bass",
                  range: "C2–B2",
                  coverage: 0.08,
                  confidence: 0.7,
                },
              ],
              modelName: "dominant-pitch-register-gating",
              modelVersion: "1.0.0",
              methodology: "dominant-pitch-register-gating",
              experimental: true,
            }
          : null,
        tracks: vocalBreakdownTracks,
      });
    }
    if (path.endsWith("/vocal-breakdown") && method === "POST") {
      const body = request.postDataJSON() as {
        parts: Array<"melody" | "soprano" | "alto" | "tenor" | "bass">;
      };
      vocalBreakdownTracks = body.parts.map((part, index) => ({
        part,
        displayName:
          part === "melody" ? "Melody guide" : `${part[0]!.toUpperCase()}${part.slice(1)} focus`,
        asset: {
          id: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`,
          projectId: project.id,
          kind: "preview",
          originalFilename: `vocal-${part}.wav`,
          mimeType: "audio/wav",
          sizeBytes: 2_880_044,
          durationMs: 60_000,
          sampleRate: 24_000,
          channels: 1,
          codec: "pcm_s16le",
          streamUrl: `/api/audio/cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}/stream`,
        },
        confidence: 0.86,
        coverage: part === "melody" ? 0.35 : 0.25,
      }));
      mix.tracks = [
        ...mix.tracks.filter((track) => track.trackType !== "vocal_breakdown"),
        ...vocalBreakdownTracks.map((track, index) => ({
          id: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index}`,
          stemId: null,
          audioAssetId: track.asset.id,
          orderIndex: mix.tracks.length + index,
          startMs: 0,
          trimStartMs: 0,
          trimEndMs: 0,
          volumeDb: track.part === "melody" ? -9 : -3,
          pan: 0,
          muted: false,
          solo: false,
          enabled: true,
          fadeInMs: 0,
          fadeOutMs: 0,
          label: track.displayName,
          trackType: "vocal_breakdown" as const,
          vocalPart: track.part,
          durationMs: 60_000,
          streamUrl: track.asset.streamUrl,
        })),
      ];
      const analysis = {
        durationMs: 60_000,
        voicedDurationMs: 21_000,
        confidence: 0.88,
        lowestNote: "A2",
        highestNote: "G5",
        medianNote: "C4",
        notes: [
          {
            startMs: 1_000,
            endMs: 3_500,
            midi: 60,
            note: "C4",
            frequencyHz: 261.63,
            confidence: 0.91,
            register: "alto",
          },
        ],
        registers: [
          {
            part: "soprano",
            displayName: "Soprano",
            range: "F♯4–C6",
            coverage: 0.18,
            confidence: 0.82,
          },
          { part: "alto", displayName: "Alto", range: "A♯3–F4", coverage: 0.42, confidence: 0.9 },
          { part: "tenor", displayName: "Tenor", range: "C3–A3", coverage: 0.32, confidence: 0.86 },
          { part: "bass", displayName: "Bass", range: "C2–B2", coverage: 0.08, confidence: 0.7 },
        ],
        modelName: "dominant-pitch-register-gating",
        modelVersion: "1.0.0",
        methodology: "dominant-pitch-register-gating",
        experimental: true,
      };
      return json(route, { analysis, tracks: vocalBreakdownTracks }, 201);
    }
    if (path.endsWith("/mix") && method === "GET") return json(route, { mix });
    if (path.endsWith("/mix") && method === "PUT") {
      const saved = request.postDataJSON() as typeof mix;
      mix = {
        ...mix,
        ...saved,
        tracks: saved.tracks.map((track, index) => ({ ...mix.tracks[index], ...track })),
      };
      return json(route, { mix: { id: mix.id, projectId: mix.projectId, name: mix.name } });
    }
    return json(
      route,
      { error: { code: "UNMOCKED", message: `${method} ${path} was not mocked.` } },
      404,
    );
  });
}

test.beforeEach(async ({ page }) => {
  project.status = "draft";
  project.sourceAudioId = null;
  detections = defaultDetections.map((detection) => ({
    ...detection,
    detectedSpans: [...detection.detectedSpans],
    selected: true,
  }));
  providerCapabilities = {
    provider: "mock",
    modelName: "deterministic-development-provider",
    modelVersion: "1.0.0",
    supportedLabels: [...instrumentLabels],
    dynamicStemCount: true,
    limitations: ["Mock output is test audio."],
    mock: true,
  };
  generatedTracks = [];
  vocalBreakdownTracks = [];
  projectJobs = [];
  mix.tracks = mix.tracks
    .filter((track) => track.trackType === "stem")
    .map((track) => ({ ...track, muted: false, solo: false, volumeDb: 0 }));
  await installMockApi(page);
});

test("root opens the Projects workspace without a landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "New project" })).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Created with love by Blueprint Studio Works (opens in a new tab)",
    }),
  ).toHaveAttribute("href", "https://blueprint-studio-works.ro");
});

test("real provider capabilities block unsupported selected labels", async ({ page }) => {
  providerCapabilities = {
    provider: "demucs",
    modelName: "htdemucs_6s",
    modelVersion: "demucs-4.1.0",
    supportedLabels: ["vocals", "drums", "bass_guitar", "guitar", "piano", "other"],
    dynamicStemCount: true,
    limitations: ["This checkpoint exposes six source categories."],
    mock: false,
  };

  await page.goto(`/projects/${project.id}/instruments`);
  await expect(page.getByText("Real provider active")).toBeVisible();
  await expect(page.locator(".provider-capability-note")).toContainText("htdemucs_6s");
  await expect(page.locator(".capability-warning")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Separate/ })).toBeDisabled();

  await page.getByLabel("Include Electric guitar").uncheck();
  await page.getByLabel("Include Strings").uncheck();
  await expect(page.getByRole("button", { name: "Separate 5 stems" })).toBeEnabled();
});

test("analyze page reports the active real provider", async ({ page }) => {
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  providerCapabilities = {
    provider: "demucs",
    modelName: "htdemucs_6s",
    modelVersion: "demucs-4.1.0",
    supportedLabels: ["vocals", "drums", "bass_guitar", "guitar", "piano", "other"],
    dynamicStemCount: true,
    limitations: ["This checkpoint exposes six source categories."],
    mock: false,
  };

  await page.goto(`/projects/${project.id}/analyze`);
  await expect(
    page.getByText("Detection will use htdemucs_6s (demucs-4.1.0) on the configured ML worker."),
  ).toBeVisible();
});

test("projects workspace shows recent processing jobs", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Recent jobs" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open E2E instrument session completed job/ }),
  ).toBeVisible();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
});

test("restores an active analysis job and its saved progress after navigation", async ({
  page,
}) => {
  project.status = "analyzing";
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  projectJobs = [
    {
      id: resumableJobId,
      projectId: project.id,
      mode: "auto",
      status: "detecting",
      progress: 37,
      currentStage: "detecting_instruments",
      provider: "mock",
      errorCode: null,
      errorMessage: null,
      queuedAt: project.createdAt,
      startedAt: project.createdAt,
      finishedAt: null,
    },
  ];

  await page.goto(`/projects/${project.id}/analyze`);
  await expect(page.getByText("Your position is saved")).toBeVisible();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze instruments" })).toHaveCount(0);

  await page.goto("/projects");
  await expect(
    page.getByText(/detecting instruments · 37% · continues in background/),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: `${project.name} 37% complete` }),
  ).toBeVisible();
  await page.getByRole("link", { name: `Open ${project.name}`, exact: true }).click();
  await expect(page).toHaveURL(
    `/projects/${project.id}/analyze?job=${encodeURIComponent(resumableJobId)}`,
  );
  await expect(page.getByText("Your position is saved")).toBeVisible();
});

test("links complementary synth and loop texture controls without adding Other twice", async ({
  page,
}) => {
  detections = [
    ...detections,
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      canonicalLabel: "synthesizer",
      displayLabel: "Synth / pads texture",
      confidence: 0.71,
      detectedSpans: [{ startMs: 0, endMs: 60_000 }],
      selected: true,
      manuallyAdded: false,
      modelName: "residual-texture-split",
      modelVersion: "1.0.0",
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      canonicalLabel: "percussion",
      displayLabel: "Loops / percussion / FX texture",
      confidence: 0.68,
      detectedSpans: [{ startMs: 0, endMs: 60_000 }],
      selected: true,
      manuallyAdded: false,
      modelName: "residual-texture-split",
      modelVersion: "1.0.0",
    },
  ];

  await page.goto(`/projects/${project.id}/instruments`);
  await expect(page.getByText("Synth & loop texture controls")).toBeVisible();
  await expect(page.getByRole("button", { name: "Separate 8 stems" })).toBeEnabled();
  await page.getByLabel("Include Synth / pads texture").uncheck();
  await expect(page.getByLabel("Include Loops / percussion / FX texture")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Separate 7 stems" })).toBeEnabled();
});

test("upload to dynamic mixer persists all stems", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/projects/new");
  await page.getByRole("textbox", { name: /Project name/ }).fill("E2E instrument session");
  await page.locator('input[type="file"]').setInputFiles({
    name: "fixture.wav",
    mimeType: "audio/wav",
    buffer: wavHeader,
  });
  await page.getByRole("button", { name: "Continue to analysis" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/analyze`);
  await page.getByRole("button", { name: "Analyze instruments" }).click();
  await expect(page.getByRole("link", { name: "Review instruments" })).toBeVisible();
  await page.getByRole("link", { name: "Review instruments" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/instruments`);
  await expect(page.locator(".instrument-row")).toHaveCount(6);
  await page.getByLabel("Display name for vocals").fill("Lead vocal");
  await page.getByRole("button", { name: "Separate 7 stems" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/separation`));
  await expect(page.getByRole("link", { name: "Open mixer" })).toBeVisible();
  await page.getByRole("link", { name: "Open mixer" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/mixer`);
  await expect(page.locator(".mixer-track")).toHaveCount(7);
  await expect(page.getByRole("meter")).toHaveCount(8);
  await page.getByLabel("Mix export format").selectOption("mp3");
  await expect(page.getByRole("button", { name: "Export MP3" })).toBeVisible();
  await page.getByRole("slider", { name: "Zoom" }).fill("2");
  await expect(page.getByRole("slider", { name: "Zoom" })).toHaveValue("2");
  await expect
    .poll(() =>
      page
        .getByRole("slider", { name: "Zoom" })
        .evaluate((element) => element.style.getPropertyValue("--range-progress")),
    )
    .toContain("33.333");
  await page.getByLabel("Vocals volume").fill("-9");
  await page.getByRole("button", { name: "Reset Vocals controls" }).click();
  await expect(page.getByLabel("Vocals volume")).toHaveValue("0");
  await page.getByRole("button", { name: "Remove Vocals from mix" }).click();
  await expect(page.locator(".mixer-track")).toHaveCount(6);
  await expect(
    page.getByText("The source files remain available and are not deleted."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore Vocals" }).click();
  await expect(page.locator(".mixer-track")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip forward 10 seconds" })).toBeVisible();
  await page.getByRole("button", { name: "Mute Vocals" }).click();
  await page.getByRole("button", { name: "Save mix" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Unmute Vocals" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("creates spoken guide cues and a measured click as mixer tracks", async ({
  page,
}, testInfo) => {
  project.status = "ready";
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  await page.goto(`/projects/${project.id}/guide-click`);

  await expect(page.getByRole("heading", { name: project.name, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Guide voice")).toHaveValue("en-US-JennyNeural");
  await expect(page.getByText(/tight, clear US cue voice/)).toBeVisible();
  await page.getByLabel("BPM").fill("128");
  await page.getByLabel("Beats per bar").selectOption("6");
  await page.getByLabel("Beat unit").selectOption("8");
  await page.getByRole("button", { name: "Chorus" }).click();
  await expect(page.getByLabel("Cue 2 spoken text")).toHaveValue("Chorus");
  await expect(page.getByText("128 BPM · 6/8")).toBeVisible();

  const generateButton = page.getByRole("button", { name: "Generate & add to mixer" });
  if (testInfo.project.name === "mobile-chromium") {
    await generateButton.focus();
    await generateButton.press("Enter");
  } else {
    await generateButton.click();
  }
  await expect(page.getByRole("heading", { name: "Tracks in this project" })).toBeVisible();
  await expect(
    page.getByText("Generation complete. The new tracks are already in the mixer."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Spoken guide" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Click track" })).toBeVisible();

  const openMixer = page.getByRole("link", { name: "Open mixer" });
  if (testInfo.project.name === "mobile-chromium") {
    await openMixer.focus();
    await openMixer.press("Enter");
  } else {
    await openMixer.click();
  }
  await expect(page).toHaveURL(`/projects/${project.id}/mixer`);
  await expect(page.locator(".mixer-track")).toHaveCount(stems.length + 2);
  await expect(page.getByText("Spoken guide", { exact: true })).toBeVisible();
  await expect(page.getByText("Metronome", { exact: true })).toBeVisible();
});

test("places a spoken guide cue directly on the mixer timeline", async ({ page }, testInfo) => {
  project.status = "ready";
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  await page.goto(`/projects/${project.id}/mixer`);

  await expect(page.getByRole("heading", { name: "Guide cues" })).toBeVisible();
  const lane = page.getByRole("group", {
    name: "Guide cue timeline. Click to add a cue.",
  });
  if (testInfo.project.name === "mobile-chromium") {
    const addAtPlayhead = page.getByRole("button", { name: "At playhead", exact: true });
    await addAtPlayhead.focus();
    await addAtPlayhead.press("Enter");
  } else {
    await lane.click({ position: { x: 240, y: 80 } });
  }
  await page.getByPlaceholder("e.g. Chorus, two, three, four").fill("Chorus, two, three, four");
  const editor = page.locator(".guide-cue-popover");
  const editorBounds = await editor.boundingBox();
  const laneBounds = await lane.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(laneBounds).not.toBeNull();
  expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(
    laneBounds!.y + laneBounds!.height,
  );
  await expect(
    page.getByRole("button", { name: "Delete cue Chorus, two, three, four" }),
  ).toBeVisible();
  const previewRequest = page.waitForRequest(
    (request) => request.url().endsWith("/guide-voice-preview") && request.method() === "POST",
  );
  const placeCue = page.getByRole("button", { name: "Place & hear" });
  if (testInfo.project.name === "mobile-chromium") {
    await placeCue.focus();
    await placeCue.press("Enter");
  } else {
    await placeCue.click();
  }
  const preview = await previewRequest;
  expect(preview.postDataJSON()).toMatchObject({
    voiceName: "en-US-JennyNeural",
    text: "Chorus, two, three, four",
  });
  await expect(page.getByRole("button", { name: /Edit cue Chorus/ })).toBeVisible();
  await expect(page.locator(".guide-cue-line")).toHaveCount(1);

  const generationRequest = page.waitForRequest(
    (request) => request.url().endsWith("/guide-tracks") && request.method() === "POST",
  );
  const generateGuide = page.getByRole("button", { name: "Generate guide" });
  if (testInfo.project.name === "mobile-chromium") {
    await generateGuide.focus();
    await generateGuide.press("Enter");
  } else {
    await generateGuide.click();
  }
  const request = await generationRequest;
  const body = request.postDataJSON() as {
    createGuide: boolean;
    createClick: boolean;
    cues: Array<{ text: string }>;
  };
  expect(body.createGuide).toBe(true);
  expect(body.createClick).toBe(false);
  expect(body.cues.map((cue) => cue.text)).toContain("Chorus, two, three, four");
  await expect(page.getByText("Guide generated at 1:00 and added to the mixer.")).toBeVisible();
  await expect(page.locator(".mixer-track")).toHaveCount(stems.length + 1);

  await page.getByRole("button", { name: "At playhead", exact: true }).click();
  await page.getByPlaceholder("e.g. Chorus, two, three, four").fill("Wrong cue");
  await page.getByRole("button", { name: "Delete cue Wrong cue" }).click();
  await expect(page.getByRole("button", { name: /Edit cue Wrong cue/ })).toHaveCount(0);
  await expect(page.locator(".guide-cue-line")).toHaveCount(1);
});

test("replays a draft guide cue when the song transport reaches it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __guideBlobPlayCount?: number }).__guideBlobPlayCount = 0;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this.src.startsWith("blob:")) {
        const testWindow = window as Window & { __guideBlobPlayCount?: number };
        testWindow.__guideBlobPlayCount = (testWindow.__guideBlobPlayCount ?? 0) + 1;
        window.setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
      }
      return Promise.resolve();
    };
  });

  project.status = "ready";
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  await page.goto(`/projects/${project.id}/mixer`);

  await page.getByRole("button", { name: "At playhead", exact: true }).click();
  await page.getByPlaceholder("e.g. Chorus, two, three, four").fill("Intro");
  await page.getByRole("button", { name: "Place & hear" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __guideBlobPlayCount?: number }).__guideBlobPlayCount ?? 0,
      ),
    )
    .toBe(1);
  await expect(page.getByText(/live draft armed/)).toBeVisible();

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __guideBlobPlayCount?: number }).__guideBlobPlayCount ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/live draft playing/)).toBeVisible();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText(/live draft armed/)).toBeVisible();
});

test("creates experimental vocal learning tracks and adds them to the mixer", async ({ page }) => {
  project.status = "ready";
  project.sourceAudioId = "88888888-8888-4888-8888-888888888888";
  await page.goto(`/projects/${project.id}/vocal-breakdown`);

  await expect(page.getByRole("heading", { name: "Learning tracks" })).toBeVisible();
  await expect(page.getByText("Experimental register focus")).toBeVisible();
  await page.getByRole("button", { name: "Analyze vocal stem" }).click();
  await expect(page.getByRole("heading", { name: "Detected melody" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Practice tracks" })).toBeVisible();
  await expect(page.locator(".vocal-track")).toHaveCount(5);
  await page.getByRole("link", { name: "Open mixer" }).click();
  await expect(page.locator(".mixer-track")).toHaveCount(stems.length + 5);
  await expect(page.getByText("Melody guide", { exact: true })).toBeVisible();
  await expect(page.getByText("Alto focus", { exact: true })).toBeVisible();
});
