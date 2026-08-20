import { expect, test } from "@playwright/test";

test("real seven-stem mixer remains synchronized through play and seek", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(
    "http://localhost:5173/projects/897f38fe-d4a7-4f44-8e97-8d9f5635c055/mixer",
    { waitUntil: "domcontentloaded", timeout: 60_000 },
  );
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => page.locator("audio").count(), { timeout: 30_000 }).toBe(7);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByText("Syncing stems…")).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(5_000);

  const firstPlayback = await page.locator("audio").evaluateAll((elements) =>
    elements.map((element) => {
      const audio = element as HTMLAudioElement;
      return {
        paused: audio.paused,
        readyState: audio.readyState,
        currentTime: audio.currentTime,
        playbackRate: audio.playbackRate,
        src: audio.currentSrc,
      };
    }),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(firstPlayback.every((item) => !item.paused && item.readyState >= 2)).toBe(true);
  const firstTimes = firstPlayback.map((item) => item.currentTime);
  const firstSpreadMs = (Math.max(...firstTimes) - Math.min(...firstTimes)) * 1_000;
  console.log(`real mixer spread after play: ${firstSpreadMs.toFixed(1)}ms`);
  expect(firstSpreadMs).toBeLessThan(180);
  expect(firstPlayback.every((item) => item.src.endsWith("/playback"))).toBe(true);

  await page.getByRole("slider", { name: "Timeline position" }).fill("235000");
  await expect(page.getByText("Syncing stems…")).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const afterSeek = await page.locator("audio").evaluateAll((elements) =>
    elements.map((element) => {
      const audio = element as HTMLAudioElement;
      return { paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime };
    }),
  );
  expect(afterSeek.every((item) => !item.paused && item.readyState >= 2)).toBe(true);
  const seekTimes = afterSeek.map((item) => item.currentTime);
  const seekSpreadMs = (Math.max(...seekTimes) - Math.min(...seekTimes)) * 1_000;
  console.log(`real mixer spread after seek: ${seekSpreadMs.toFixed(1)}ms`);
  expect(seekSpreadMs).toBeLessThan(180);
});
