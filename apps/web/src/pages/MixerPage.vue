<script setup lang="ts">
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconDownload,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconRestore,
  IconMetronome,
  IconMusic,
  IconVolume,
  IconZoomIn,
} from "@tabler/icons-vue";
import { useMutation, useQuery } from "@tanstack/vue-query";
import type { SaveMixInput } from "@audiotool/contracts";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import MixerTrack from "../components/audio/MixerTrack.vue";
import GuideCueOverlay from "../components/audio/GuideCueOverlay.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import RangeSlider from "../components/ui/RangeSlider.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api, apiUrl, subscribeToJob, type ToolAudioFormat } from "../lib/api";
import { decibelsToGain, formatDuration } from "../lib/format";
import type { MixerTrackState } from "../types/mixer";

interface AudioGraph {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
}

const palette = [
  "oklch(0.68 0.16 252)",
  "oklch(0.72 0.17 48)",
  "oklch(0.7 0.13 153)",
  "oklch(0.72 0.14 320)",
  "oklch(0.76 0.14 86)",
  "oklch(0.69 0.12 205)",
  "oklch(0.72 0.15 25)",
];

const generatedTrackColors = {
  guide: "oklch(0.72 0.14 320)",
  click: "oklch(0.76 0.14 86)",
} as const;
const vocalTrackColors = {
  melody: "oklch(0.7 0.15 252)",
  soprano: "oklch(0.72 0.14 320)",
  alto: "oklch(0.73 0.16 48)",
  tenor: "oklch(0.69 0.12 205)",
  bass: "oklch(0.66 0.12 153)",
} as const;

const route = useRoute();
const projectId = computed(() => String(route.params.id));
const projectQuery = useQuery({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () => api.getProject(projectId.value),
});
const mixQuery = useQuery({
  queryKey: computed(() => ["mix", projectId.value]),
  queryFn: () => api.getMix(projectId.value),
});
const stemsQuery = useQuery({
  queryKey: computed(() => ["stems", projectId.value]),
  queryFn: () => api.getStems(projectId.value),
});

const tracks = ref<MixerTrackState[]>([]);
const mixName = ref("Main mix");
const masterVolumeDb = ref(0);
const timelineZoom = ref(1);
const playing = ref(false);
const currentMs = ref(0);
const durationMs = ref(0);
const saveState = ref<"idle" | "saved" | "error">("idle");
const renderState = ref<"idle" | "saving" | "rendering" | "error">("idle");
const renderProgress = ref(0);
const renderFormat = ref<ToolAudioFormat>("wav");
const playbackError = ref("");
const guideDraftActive = ref(false);
const transportSyncing = ref(false);
const audioElements = new Map<string, HTMLAudioElement>();
const observedAudioElements = new WeakSet<HTMLAudioElement>();
const graphs = new Map<string, AudioGraph>();
const meterElements = new Map<string, HTMLElement>();
const masterMeter = ref<HTMLElement | null>(null);
let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let masterAnalyser: AnalyserNode | null = null;
let masterSamples: Uint8Array<ArrayBuffer> | null = null;
let masterLimiter: DynamicsCompressorNode | null = null;
let animationFrame = 0;
let transportStartedAt = 0;
let transportStartMs = 0;
let transportGeneration = 0;
let seekTimer: number | null = null;
let recoveryTimer: number | null = null;
let lastDriftCheckAt = 0;
let recoveryBlockedUntil = 0;
let unsubscribeRender: (() => void) | null = null;

const currentRatio = computed(() =>
  durationMs.value > 0 ? currentMs.value / durationMs.value : 0,
);
const activeTracks = computed(() => tracks.value.filter((track) => track.enabled));
const removedTracks = computed(() => tracks.value.filter((track) => !track.enabled));
const hasSolo = computed(() => activeTracks.value.some((track) => track.solo));
const rulerTicks = computed(() => {
  const totalSeconds = durationMs.value / 1000;
  if (totalSeconds <= 0) return [{ milliseconds: 0, ratio: 0, label: "0:00" }];
  const timelineWidth = timelineZoom.value * 900;
  const maximumLabels = Math.max(2, Math.floor(timelineWidth / 92));
  const rawInterval = totalSeconds / maximumLabels;
  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const interval = intervals.find((candidate) => candidate >= rawInterval) ?? 3600;
  const ticks: Array<{ milliseconds: number; ratio: number; label: string }> = [];
  for (let seconds = 0; seconds < totalSeconds; seconds += interval) {
    ticks.push({
      milliseconds: seconds * 1000,
      ratio: seconds / totalSeconds,
      label: formatDuration(seconds * 1000),
    });
  }
  ticks.push({ milliseconds: durationMs.value, ratio: 1, label: formatDuration(durationMs.value) });
  return ticks;
});

watch(
  () => mixQuery.data.value?.mix,
  (mix) => {
    if (!mix) return;
    mixName.value = mix.name;
    masterVolumeDb.value = mix.masterSettings.volumeDb;
    tracks.value = mix.tracks.map((track, index) => ({
      ...track,
      enabled: track.enabled !== false,
      color:
        track.trackType === "guide" || track.trackType === "click"
          ? generatedTrackColors[track.trackType]
          : track.trackType === "vocal_breakdown" && track.vocalPart
            ? vocalTrackColors[track.vocalPart]
            : (palette[index % palette.length] ?? palette[0]!),
      sourceDurationMs: track.durationMs,
    }));
    syncAudioGraph();
    void nextTick(() => {
      for (const [trackId, element] of audioElements) applyElementDuration(trackId, element);
    });
  },
  { immediate: true },
);

watch(
  [tracks, masterVolumeDb, guideDraftActive],
  () => {
    recalculateDuration();
    syncAudioGraph();
  },
  { deep: true },
);

function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterAnalyser = audioContext.createAnalyser();
    masterAnalyser.fftSize = 256;
    masterSamples = new Uint8Array(masterAnalyser.fftSize);
    masterLimiter = audioContext.createDynamicsCompressor();
    masterLimiter.threshold.value = -1;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.003;
    masterLimiter.release.value = 0.25;
    masterGain.connect(masterAnalyser).connect(masterLimiter).connect(audioContext.destination);
  }
}

function applyElementDuration(trackId: string, element: HTMLAudioElement) {
  if (!Number.isFinite(element.duration) || element.duration <= 0) return;
  const index = tracks.value.findIndex((track) => (track.id ?? track.audioAssetId) === trackId);
  const track = tracks.value[index];
  const nextDurationMs = Math.round(element.duration * 1_000);
  if (index >= 0 && track && track.sourceDurationMs !== nextDurationMs) {
    tracks.value[index] = { ...track, sourceDurationMs: nextDurationMs };
  }
}

function registerAudio(trackId: string, element: HTMLAudioElement | null) {
  if (!element) {
    audioElements.delete(trackId);
    const graph = graphs.get(trackId);
    graph?.source.disconnect();
    graph?.gain.disconnect();
    graph?.pan.disconnect();
    graph?.analyser.disconnect();
    graphs.delete(trackId);
    return;
  }
  audioElements.set(trackId, element);
  const updateDuration = () => applyElementDuration(trackId, element);
  if (!observedAudioElements.has(element)) {
    observedAudioElements.add(element);
    element.addEventListener("loadedmetadata", updateDuration);
    element.addEventListener("durationchange", updateDuration);
    element.addEventListener("error", () => {
      playbackError.value =
        "A stem could not be loaded. Check that the API and audio files are available.";
    });
    element.addEventListener("waiting", requestTransportRecovery);
    element.addEventListener("stalled", requestTransportRecovery);
  }
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) updateDuration();
}

function registerMeter(trackId: string, element: HTMLElement | null) {
  if (element) meterElements.set(trackId, element);
  else meterElements.delete(trackId);
}

function recalculateDuration() {
  durationMs.value = activeTracks.value.reduce((maximum, track) => {
    const effective = Math.max(0, track.sourceDurationMs - track.trimStartMs - track.trimEndMs);
    return Math.max(maximum, track.startMs + effective);
  }, 0);
  currentMs.value = Math.min(currentMs.value, durationMs.value);
}

function connectAudioElements() {
  ensureContext();
  if (!audioContext || !masterGain) return;
  for (const track of activeTracks.value) {
    const id = track.id ?? track.audioAssetId;
    const element = audioElements.get(id);
    if (!element || graphs.has(id)) continue;
    const source = audioContext.createMediaElementSource(element);
    const gain = audioContext.createGain();
    const pan = audioContext.createStereoPanner();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(gain).connect(pan).connect(analyser).connect(masterGain);
    graphs.set(id, { source, gain, pan, analyser, samples: new Uint8Array(analyser.fftSize) });
  }
}

function fadeFactor(track: MixerTrackState): number {
  const localMs = currentMs.value - track.startMs;
  const effective = Math.max(0, track.sourceDurationMs - track.trimStartMs - track.trimEndMs);
  if (!track.enabled || localMs < 0 || localMs >= effective) return 0;
  const fadeIn = track.fadeInMs > 0 ? Math.min(1, localMs / track.fadeInMs) : 1;
  const remaining = effective - localMs;
  const fadeOut = track.fadeOutMs > 0 ? Math.min(1, remaining / track.fadeOutMs) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

function syncAudioGraph() {
  if (masterGain) masterGain.gain.value = decibelsToGain(masterVolumeDb.value);
  for (const track of activeTracks.value) {
    const id = track.id ?? track.audioAssetId;
    const graph = graphs.get(id);
    if (!graph) continue;
    const audible =
      !track.muted &&
      (!hasSolo.value || track.solo) &&
      !(guideDraftActive.value && track.trackType === "guide");
    graph.gain.gain.value = audible ? decibelsToGain(track.volumeDb) * fadeFactor(track) : 0;
    graph.pan.pan.value = track.pan;
  }
}

interface PositionedMedia {
  track: MixerTrackState;
  element: HTMLAudioElement;
  desiredSeconds: number;
}

function positionedMedia(positionMs: number): PositionedMedia[] {
  const positioned: PositionedMedia[] = [];
  for (const track of activeTracks.value) {
    const id = track.id ?? track.audioAssetId;
    const element = audioElements.get(id);
    if (!element || track.sourceDurationMs <= 0) continue;
    const effective = Math.max(0, track.sourceDurationMs - track.trimStartMs - track.trimEndMs);
    const localMs = positionMs - track.startMs;
    const inWindow = localMs >= 0 && localMs < effective;
    if (!inWindow) {
      if (!element.paused) element.pause();
      continue;
    }
    positioned.push({
      track,
      element,
      desiredSeconds: (track.trimStartMs + localMs) / 1000,
    });
  }
  return positioned;
}

function pauseAllMedia() {
  for (const element of audioElements.values()) {
    element.pause();
    element.playbackRate = 1;
  }
}

function waitForMediaReady(
  element: HTMLAudioElement,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const events = ["loadedmetadata", "loadeddata", "canplay", "seeked", "error", "abort"];
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const event of events) element.removeEventListener(event, check);
      resolve(ready);
    };
    const check = () => {
      if (element.error) finish(false);
      else if (predicate()) finish(true);
    };
    const timeout = window.setTimeout(() => finish(predicate()), timeoutMs);
    for (const event of events) element.addEventListener(event, check);
  });
}

async function prepareMediaElement(media: PositionedMedia, generation: number): Promise<boolean> {
  const { element, desiredSeconds } = media;
  element.pause();
  element.preload = "auto";
  element.playbackRate = 1;

  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && !element.error) {
    element.load();
    const metadataReady = await waitForMediaReady(
      element,
      () => element.readyState >= HTMLMediaElement.HAVE_METADATA,
      45_000,
    );
    if (!metadataReady || generation !== transportGeneration) return false;
  }

  if (generation !== transportGeneration) return false;
  if (Math.abs(element.currentTime - desiredSeconds) > 0.015) {
    element.currentTime = desiredSeconds;
  }
  return waitForMediaReady(
    element,
    () => !element.seeking && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
    15_000,
  );
}

function mediaTimelinePositions(positionMs: number): number[] {
  return positionedMedia(positionMs)
    .filter(({ element }) => !element.paused && !element.seeking)
    .map(({ track, element }) => element.currentTime * 1_000 - track.trimStartMs + track.startMs);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function gentlyCorrectMediaDrift(media: PositionedMedia[], centerMs: number) {
  for (const { track, element } of media) {
    if (element.paused || element.seeking) continue;
    const timelineMs = element.currentTime * 1_000 - track.trimStartMs + track.startMs;
    const driftMs = timelineMs - centerMs;
    const nextRate =
      Math.abs(driftMs) < 8 ? 1 : Math.max(0.98, Math.min(1.02, 1 - driftMs / 2_000));
    if (Math.abs(element.playbackRate - nextRate) > 0.001) element.playbackRate = nextRate;
  }
}

async function startTransportAt(positionMs: number, generation: number) {
  if (!audioContext || generation !== transportGeneration || !playing.value) return;
  transportSyncing.value = true;
  cancelAnimationFrame(animationFrame);
  pauseAllMedia();
  const media = positionedMedia(positionMs);
  const readiness = await Promise.all(media.map((item) => prepareMediaElement(item, generation)));
  if (generation !== transportGeneration || !playing.value) return;
  const unavailable = readiness.some(
    (ready, index) =>
      !ready ||
      (media[index]?.element.readyState ?? HTMLMediaElement.HAVE_NOTHING) <
        HTMLMediaElement.HAVE_FUTURE_DATA,
  );
  if (unavailable) {
    pauseAllMedia();
    playing.value = false;
    transportSyncing.value = false;
    playbackError.value =
      "A stem could not buffer in time. Playback was stopped to keep every instrument synchronized.";
    updateMeters();
    return;
  }

  transportStartMs = positionMs;
  transportStartedAt = audioContext.currentTime;
  const outcomes = await Promise.allSettled(media.map(({ element }) => element.play()));
  if (generation !== transportGeneration || !playing.value) {
    pauseAllMedia();
    return;
  }
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    pauseAllMedia();
    playing.value = false;
    transportSyncing.value = false;
    playbackError.value =
      "A stem could not start. Playback was stopped instead of playing an incomplete mix.";
    updateMeters();
    return;
  }

  const synchronizedPosition = median(mediaTimelinePositions(positionMs)) ?? positionMs;
  currentMs.value = synchronizedPosition;
  transportStartMs = synchronizedPosition;
  transportStartedAt = audioContext.currentTime;
  transportSyncing.value = false;
  recoveryBlockedUntil = performance.now() + 1_500;
  syncAudioGraph();
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(tick);
}

function requestTransportRecovery() {
  if (!playing.value || transportSyncing.value || !audioContext) return;
  const now = performance.now();
  if (now < recoveryBlockedUntil || recoveryTimer !== null) return;
  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null;
    if (!playing.value || transportSyncing.value || !audioContext) return;
    const expected = positionedMedia(currentMs.value);
    const stillStarved = expected.some(
      ({ element }) =>
        element.paused || element.seeking || element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    );
    if (!stillStarved) return;
    recoveryBlockedUntil = performance.now() + 3_000;
    const position = median(mediaTimelinePositions(currentMs.value)) ?? currentMs.value;
    const generation = ++transportGeneration;
    transportSyncing.value = true;
    cancelAnimationFrame(animationFrame);
    pauseAllMedia();
    void startTransportAt(position, generation);
  }, 180);
}

function analyserLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let squared = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    squared += normalized * normalized;
  }
  const rms = Math.sqrt(squared / samples.length);
  const decibels = rms > 0 ? 20 * Math.log10(rms) : -60;
  return Math.max(0, Math.min(1, (decibels + 60) / 60));
}

function writeMeter(element: HTMLElement | null | undefined, level: number) {
  if (!element) return;
  element.style.transform = `scaleX(${level.toFixed(4)})`;
  element.parentElement?.setAttribute("aria-valuenow", String(Math.round(-60 + level * 60)));
}

function updateMeters() {
  for (const [id, graph] of graphs) {
    writeMeter(
      meterElements.get(id),
      playing.value && !transportSyncing.value ? analyserLevel(graph.analyser, graph.samples) : 0,
    );
  }
  writeMeter(
    masterMeter.value,
    playing.value && !transportSyncing.value && masterAnalyser && masterSamples
      ? analyserLevel(masterAnalyser, masterSamples)
      : 0,
  );
}

function updateTrack(updated: MixerTrackState) {
  const index = tracks.value.findIndex(
    (track) => (track.id ?? track.audioAssetId) === (updated.id ?? updated.audioAssetId),
  );
  if (index >= 0) tracks.value[index] = updated;
  saveState.value = "idle";
}

function resetTrack(track: MixerTrackState) {
  updateTrack({
    ...track,
    startMs: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
}

function removeTrack(track: MixerTrackState) {
  const element = audioElements.get(track.id ?? track.audioAssetId);
  element?.pause();
  updateTrack({ ...track, enabled: false, solo: false });
}

async function restoreTrack(track: MixerTrackState) {
  updateTrack({ ...track, enabled: true });
  await nextTick();
  if (playing.value) {
    connectAudioElements();
    requestTransportRecovery();
  }
}

function tick() {
  if (!audioContext || !playing.value || transportSyncing.value) return;
  const positions = mediaTimelinePositions(currentMs.value);
  currentMs.value = Math.min(
    durationMs.value,
    median(positions) ?? transportStartMs + (audioContext.currentTime - transportStartedAt) * 1_000,
  );
  syncAudioGraph();
  updateMeters();
  if (currentMs.value >= durationMs.value) {
    pauseAllMedia();
    playing.value = false;
    updateMeters();
    return;
  }

  const now = performance.now();
  if (now - lastDriftCheckAt >= 750) {
    lastDriftCheckAt = now;
    const expected = positionedMedia(currentMs.value);
    const spread = positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : 0;
    const unexpectedlyUnavailable = expected.some(
      ({ element }) =>
        element.paused ||
        element.seeking ||
        element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA,
    );
    if (spread > 180 || unexpectedlyUnavailable) {
      requestTransportRecovery();
      return;
    }
    const center = median(positions);
    if (center !== null) gentlyCorrectMediaDrift(expected, center);
  }
  animationFrame = requestAnimationFrame(tick);
}

async function play() {
  if (activeTracks.value.length === 0 || durationMs.value <= 0) return;
  if (seekTimer) {
    clearTimeout(seekTimer);
    seekTimer = null;
  }
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  playbackError.value = "";
  connectAudioElements();
  if (audioContext?.state === "suspended") await audioContext.resume();
  if (!audioContext) return;
  if (currentMs.value >= durationMs.value) currentMs.value = 0;
  playing.value = true;
  transportSyncing.value = true;
  const generation = ++transportGeneration;
  await startTransportAt(currentMs.value, generation);
}

function pause() {
  transportGeneration += 1;
  if (seekTimer) {
    clearTimeout(seekTimer);
    seekTimer = null;
  }
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  pauseAllMedia();
  playing.value = false;
  transportSyncing.value = false;
  cancelAnimationFrame(animationFrame);
  updateMeters();
}

function seek(ratio: number) {
  const nextMs = Math.max(0, Math.min(durationMs.value, ratio * durationMs.value));
  currentMs.value = nextMs;
  transportStartMs = nextMs;
  if (audioContext) transportStartedAt = audioContext.currentTime;
  const generation = ++transportGeneration;
  if (seekTimer) clearTimeout(seekTimer);
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (!playing.value || !audioContext) {
    seekTimer = null;
    transportSyncing.value = false;
    pauseAllMedia();
    return;
  }
  transportSyncing.value = true;
  cancelAnimationFrame(animationFrame);
  pauseAllMedia();
  seekTimer = window.setTimeout(() => {
    seekTimer = null;
    void startTransportAt(nextMs, generation);
  }, 90);
}

function restart() {
  seek(0);
}

function skipForward() {
  if (durationMs.value <= 0) return;
  seek(Math.min(1, (currentMs.value + 10_000) / durationMs.value));
}

const saveMix = useMutation({
  mutationFn: async () => {
    const payload: SaveMixInput = {
      name: mixName.value,
      masterSettings: { volumeDb: masterVolumeDb.value },
      tracks: tracks.value.map((track) => ({
        ...(track.id ? { id: track.id } : {}),
        stemId: track.stemId ?? null,
        audioAssetId: track.audioAssetId,
        orderIndex: track.orderIndex,
        startMs: track.startMs,
        trimStartMs: track.trimStartMs,
        trimEndMs: track.trimEndMs,
        volumeDb: track.volumeDb,
        pan: track.pan,
        muted: track.muted,
        solo: track.solo,
        enabled: track.enabled,
        fadeInMs: track.fadeInMs,
        fadeOutMs: track.fadeOutMs,
      })),
    };
    return api.saveMix(projectId.value, payload);
  },
  onSuccess: () => (saveState.value = "saved"),
  onError: () => (saveState.value = "error"),
});

async function renderAndDownload() {
  if (renderState.value !== "idle" && renderState.value !== "error") return;
  renderState.value = "saving";
  renderProgress.value = 0;
  try {
    await saveMix.mutateAsync();
    const { job } = await api.renderMix(projectId.value, renderFormat.value);
    renderState.value = "rendering";
    unsubscribeRender?.();
    unsubscribeRender = subscribeToJob(job.id, async (event) => {
      renderProgress.value = event.progress;
      if (event.status === "completed") {
        unsubscribeRender?.();
        unsubscribeRender = null;
        const result = await api.getExports(projectId.value);
        const latest = result.exports[0];
        if (latest) {
          const anchor = document.createElement("a");
          anchor.href = apiUrl(latest.streamUrl);
          anchor.download = latest.originalFilename;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          renderState.value = "idle";
        } else renderState.value = "error";
      } else if (event.status === "failed" || event.status === "cancelled") {
        renderState.value = "error";
        unsubscribeRender?.();
        unsubscribeRender = null;
      }
    });
  } catch {
    renderState.value = "error";
  }
}

function trackDownload(track: MixerTrackState): string | undefined {
  if (track.stemId) return apiUrl(`/api/stems/${track.stemId}/download`);
  if (
    track.trackType === "guide" ||
    track.trackType === "click" ||
    track.trackType === "vocal_breakdown"
  ) {
    return apiUrl(track.streamUrl);
  }
  return undefined;
}

onBeforeUnmount(() => {
  pause();
  unsubscribeRender?.();
  void audioContext?.close();
});
</script>

<template>
  <div class="mixer-page">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Multitrack mixer'"
      description="All stems run against one transport. Track settings persist when you save the mix."
    >
      <template #actions>
        <RouterLink class="button button--secondary" :to="`/projects/${projectId}/vocal-breakdown`">
          <IconMusic :size="17" /> Vocal breakdown
        </RouterLink>
        <RouterLink class="button button--secondary" :to="`/projects/${projectId}/guide-click`">
          <IconMetronome :size="17" /> Guide & click
        </RouterLink>
        <RouterLink class="button button--secondary" to="/projects">
          <IconArrowLeft :size="17" /> Projects
        </RouterLink>
        <button
          class="button button--primary"
          type="button"
          :disabled="saveMix.isPending.value || activeTracks.length === 0"
          @click="saveMix.mutate()"
        >
          <IconDeviceFloppy :size="17" />
          {{ saveMix.isPending.value ? "Saving" : saveState === "saved" ? "Saved" : "Save mix" }}
        </button>
        <a class="button button--secondary" :href="apiUrl(`/api/projects/${projectId}/stems.zip`)">
          <IconDownload :size="17" /> All stems
        </a>
        <div class="export-control">
          <label class="visually-hidden" for="mix-export-format">Mix export format</label>
          <select
            id="mix-export-format"
            v-model="renderFormat"
            class="select export-format-select"
            :disabled="renderState === 'saving' || renderState === 'rendering'"
          >
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
            <option value="flac">FLAC</option>
          </select>
          <button
            class="button button--accent"
            type="button"
            :disabled="
              activeTracks.length === 0 || renderState === 'saving' || renderState === 'rendering'
            "
            @click="renderAndDownload"
          >
            <IconDownload :size="17" />
            {{
              renderState === "saving"
                ? "Saving"
                : renderState === "rendering"
                  ? `Rendering ${renderProgress}%`
                  : `Export ${renderFormat.toUpperCase()}`
            }}
          </button>
        </div>
      </template>
    </PageHeader>
    <ProjectStepper :current="4" />

    <div v-if="mixQuery.isPending.value" class="mixer-skeleton">
      <div v-for="item in 5" :key="item" class="skeleton" />
    </div>
    <div v-else-if="mixQuery.isError.value" class="error-banner" role="alert">
      {{ mixQuery.error.value?.message ?? "The mix session could not be loaded." }}
    </div>
    <div v-else-if="!mixQuery.data.value?.mix" class="error-banner" role="alert">
      No mix session exists yet. Finish stem separation before opening the mixer.
    </div>
    <template v-else>
      <section
        class="mixer-transport"
        aria-label="Transport controls"
        :aria-busy="transportSyncing"
      >
        <div class="transport-buttons">
          <button
            class="transport-button"
            type="button"
            aria-label="Return to start"
            @click="restart"
          >
            <IconPlayerSkipBack :size="18" />
          </button>
          <button
            class="transport-button transport-button--primary"
            type="button"
            :disabled="durationMs <= 0"
            :aria-label="playing ? (transportSyncing ? 'Pause synchronization' : 'Pause') : 'Play'"
            @click="playing ? pause() : play()"
          >
            <IconLoader2 v-if="transportSyncing" :size="21" class="spin" />
            <IconPlayerPause v-else-if="playing" :size="22" />
            <IconPlayerPlay v-else :size="22" class="play-icon" />
          </button>
          <button
            class="transport-button"
            type="button"
            :disabled="durationMs <= 0"
            aria-label="Skip forward 10 seconds"
            @click="skipForward"
          >
            <IconPlayerSkipForward :size="18" />
          </button>
          <span v-if="transportSyncing" class="transport-sync-status" role="status">
            Syncing stems…
          </span>
        </div>
        <div class="transport-timeline">
          <output aria-label="Current playback time">{{ formatDuration(currentMs) }}</output>
          <RangeSlider
            class="transport-seek"
            :model-value="currentMs"
            :min="0"
            :max="Math.max(1, durationMs)"
            :step="10"
            aria-label="Timeline position"
            :aria-value-text="`${formatDuration(currentMs)} of ${formatDuration(durationMs)}`"
            @update:model-value="seek($event / Math.max(1, durationMs))"
          />
          <output aria-label="Total duration">{{ formatDuration(durationMs) }}</output>
        </div>
        <label class="master-level">
          <IconVolume :size="18" />
          <span>Master</span>
          <RangeSlider
            v-model="masterVolumeDb"
            :min="-60"
            :max="12"
            :step="0.5"
            aria-label="Master volume"
            :aria-value-text="`${masterVolumeDb.toFixed(1)} decibels`"
          />
          <output>{{ masterVolumeDb > 0 ? "+" : "" }}{{ masterVolumeDb.toFixed(1) }} dB</output>
          <span
            class="master-meter"
            role="meter"
            aria-label="Master output level"
            aria-valuemin="-60"
            aria-valuemax="0"
            aria-valuenow="-60"
          >
            <i ref="masterMeter" />
          </span>
        </label>
        <label class="timeline-zoom">
          <IconZoomIn :size="18" />
          <span>Zoom</span>
          <RangeSlider
            v-model="timelineZoom"
            :min="1"
            :max="4"
            :step="0.25"
            aria-label="Zoom"
            :aria-value-text="`${timelineZoom.toFixed(2)} times`"
          />
          <output>{{ timelineZoom.toFixed(2) }}x</output>
        </label>
      </section>

      <p v-if="playbackError" class="error-banner mixer-playback-error" role="alert">
        {{ playbackError }}
      </p>

      <div class="desktop-note">
        For precise waveform editing, a desktop-sized screen is recommended.
      </div>

      <section
        class="mixer-tracks"
        aria-label="Mix tracks"
        :style="{ '--timeline-width': `${Math.round(timelineZoom * 900)}px` }"
      >
        <div class="mixer-ruler" aria-label="Timeline ruler">
          <span
            v-for="(tick, index) in rulerTicks"
            :key="tick.milliseconds"
            :class="{
              'mixer-ruler__tick--first': index === 0,
              'mixer-ruler__tick--last': index === rulerTicks.length - 1,
            }"
            :style="{ left: `${tick.ratio * 100}%` }"
          >
            {{ tick.label }}
          </span>
        </div>
        <GuideCueOverlay
          :project-id="projectId"
          :duration-ms="durationMs"
          :current-ms="currentMs"
          :playing="playing && !transportSyncing"
          @seek="seek"
          @draft-active="guideDraftActive = $event"
        />
        <MixerTrack
          v-for="track in activeTracks"
          :key="track.id ?? track.audioAssetId"
          :track="track"
          :timeline-duration-ms="durationMs"
          :source-duration-ms="track.sourceDurationMs"
          :current-ratio="currentRatio"
          :register-audio="registerAudio"
          :register-meter="registerMeter"
          :download-url="trackDownload(track)"
          @update="updateTrack"
          @seek="seek"
          @remove="removeTrack"
          @reset="resetTrack"
        />
        <div v-if="activeTracks.length === 0" class="mixer-empty-track" role="status">
          <strong>No tracks in the active mix</strong>
          <span>Restore at least one stem below before playback or export.</span>
        </div>
      </section>

      <section v-if="removedTracks.length" class="removed-tracks" aria-labelledby="removed-title">
        <div>
          <strong id="removed-title">Removed tracks</strong>
          <span>The source files remain available and are not deleted.</span>
        </div>
        <button
          v-for="track in removedTracks"
          :key="track.id ?? track.audioAssetId"
          class="button button--secondary button--small"
          type="button"
          @click="restoreTrack(track)"
        >
          <IconRestore :size="16" /> Restore {{ track.label }}
        </button>
      </section>

      <p v-if="saveState === 'error'" class="error-banner" role="alert">
        The mix could not be saved. Your controls remain unchanged so you can retry.
      </p>
      <p v-if="renderState === 'error'" class="error-banner" role="alert">
        The rendered mix could not be created. Check the job log and retry.
      </p>
      <p class="mixer-provider-note">
        {{ stemsQuery.data.value?.stems.length ?? tracks.length }} generated stems. The current
        backend provider is labelled in job history.
      </p>
    </template>
  </div>
</template>
