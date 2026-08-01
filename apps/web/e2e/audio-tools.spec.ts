import { expect, test, type Page, type Route } from "@playwright/test";

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

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installToolApi(page: Page) {
  let analysisIndex = 0;
  await page.route("**/api/tools/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tools/analyze-key-bpm") {
      const analyses = [
        { key: "A", scale: "minor", bpm: 70, confidence: 0.82, tempoCandidates: [70, 140] },
        { key: "C", scale: "major", bpm: 128, confidence: 0.76, tempoCandidates: [128] },
      ];
      const analysis = analyses[Math.min(analysisIndex, analyses.length - 1)]!;
      analysisIndex += 1;
      return json(route, {
        analysis: {
          ...analysis,
          durationMs: 12_000,
          analyzedDurationMs: 12_000,
          elapsedMs: 118,
          provider: "local-heuristic-v1",
        },
      });
    }
    if (path === "/api/tools/pitch-tempo") {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: wavHeader });
    }
    if (path === "/api/tools/cut") {
      return route.fulfill({ status: 200, contentType: "audio/mpeg", body: wavHeader });
    }
    if (path === "/api/tools/join") {
      return route.fulfill({ status: 200, contentType: "audio/flac", body: wavHeader });
    }
    return json(route, { error: { code: "UNMOCKED", message: path } }, 404);
  });
}

test.beforeEach(async ({ page }) => installToolApi(page));

test("batch key/BPM results hand off to pitch and tempo preview", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/tools/key-bpm");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "slow-groove.wav", mimeType: "audio/wav", buffer: wavHeader },
    { name: "club-track.wav", mimeType: "audio/wav", buffer: wavHeader },
  ]);
  await expect(page.locator(".analysis-file-list li")).toHaveCount(2);
  await page.getByRole("button", { name: "Analyze 2" }).click();

  await expect(page.locator(".analysis-result-row")).toHaveCount(2);
  await expect(page.getByText("70 BPM / 140 BPM")).toBeVisible();
  await expect(page.getByRole("button", { name: "CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "JSON" })).toBeEnabled();

  await page.getByRole("button", { name: "Open in Pitch & Tempo" }).first().click();
  await expect(page).toHaveURL(/\/tools\/pitch-tempo/);
  await expect(page.getByText("A minor", { exact: true })).toBeVisible();
  await expect(page.getByText("70.0 BPM", { exact: true })).toBeVisible();

  await page.getByRole("slider").nth(0).fill("3");
  await page.getByRole("slider").nth(1).fill("120");
  await expect(page.getByText("C minor", { exact: true })).toBeVisible();
  await expect(page.getByText("84.0 BPM", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Render preview" }).click();
  await expect(page.getByText("Rendered preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download WAV" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("cutter manages multiple regions and renders a chosen format", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/tools/cutter");
  await page.locator('input[type="file"]').setInputFiles({
    name: "source.wav",
    mimeType: "audio/wav",
    buffer: wavHeader,
  });
  await expect(page.getByRole("button", { name: "Region 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Split into another region" }).click();
  await expect(page.locator(".cut-region-list li")).toHaveCount(2);
  await page.getByLabel("Remove selected").check();
  await page.getByLabel("Format").selectOption("mp3");
  await page.getByRole("button", { name: "Render MP3" }).click();
  await expect(page.getByText("Rendered preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("joiner reorders, trims, normalizes, previews, and exports", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/tools/joiner");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.wav", mimeType: "audio/wav", buffer: wavHeader },
    { name: "second.wav", mimeType: "audio/wav", buffer: wavHeader },
  ]);
  await expect(page.locator(".join-list li")).toHaveCount(2);
  await expect(page.locator(".join-list li").first()).toHaveAttribute("draggable", "true");
  await page.locator(".join-list li").first().dragTo(page.locator(".join-list li").nth(1));
  await expect(page.locator(".join-list li").first()).toContainText("second.wav");
  await page.getByLabel("second.wav trim start").fill("100");
  await page.getByLabel("Between clips").selectOption("pause");
  await page.getByLabel("Transition (ms)").fill("300");
  await page.getByLabel("Output format").selectOption("flac");
  await page.getByLabel("Normalize clips").check();
  await page.getByRole("button", { name: "Render 2 clips" }).click();
  await expect(page.getByText("Joined preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download FLAC" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
