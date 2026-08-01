<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { apiUrl } from "../../lib/api";

const props = withDefaults(
  defineProps<{
    url: string;
    progress?: number;
    color?: string;
    interactive?: boolean;
    height?: number;
    regions?: Array<{ startRatio: number; endRatio: number; active?: boolean }>;
  }>(),
  { progress: 0, color: "var(--primary)", interactive: false, height: 74 },
);

const emit = defineEmits<{ seek: [ratio: number] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const playedCanvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
const failed = ref(false);
let samples: Float32Array | null = null;
let resizeObserver: ResizeObserver | null = null;
let abortController: AbortController | null = null;
let resizeFrame = 0;

function canvasColor(value: string) {
  const variable = value.match(/^var\((--[^,)]+)/)?.[1];
  return variable
    ? getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
    : value;
}

function prepareCanvas(element: HTMLCanvasElement, width: number, height: number, ratio: number) {
  const pixelWidth = Math.floor(width * ratio);
  const pixelHeight = Math.floor(height * ratio);
  if (element.width !== pixelWidth) element.width = pixelWidth;
  if (element.height !== pixelHeight) element.height = pixelHeight;
  const context = element.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function waveformPeaks(width: number) {
  if (!samples?.length) return null;
  const bars = Math.max(24, Math.floor(width / 4));
  const block = Math.max(1, Math.floor(samples.length / bars));
  const peaks = new Float32Array(bars);
  for (let index = 0; index < bars; index += 1) {
    let peak = 0;
    const start = index * block;
    const end = Math.min(samples.length, start + block);
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex] ?? 0));
    }
    peaks[index] = peak;
  }
  return { bars, peaks, barWidth: Math.max(1.2, width / bars - 1.5) };
}

function drawBars(
  context: CanvasRenderingContext2D,
  waveform: NonNullable<ReturnType<typeof waveformPeaks>>,
  width: number,
  height: number,
  color: string,
) {
  context.fillStyle = color;
  for (let index = 0; index < waveform.bars; index += 1) {
    const x = (index / waveform.bars) * width;
    const barHeight = Math.max(2, (waveform.peaks[index] ?? 0) * (height - 10));
    context.fillRect(x, (height - barHeight) / 2, waveform.barWidth, barHeight);
  }
}

function draw() {
  const element = canvas.value;
  const playedElement = playedCanvas.value;
  if (!element || !playedElement) return;
  const width = Math.max(1, element.clientWidth);
  const height = props.height;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const context = prepareCanvas(element, width, height, ratio);
  const playedContext = prepareCanvas(playedElement, width, height, ratio);
  if (!context || !playedContext) return;

  if (props.regions?.length) {
    const rootStyle = getComputedStyle(document.documentElement);
    for (const region of props.regions) {
      const start = Math.max(0, Math.min(1, region.startRatio)) * width;
      const end = Math.max(0, Math.min(1, region.endRatio)) * width;
      context.fillStyle = rootStyle
        .getPropertyValue(region.active ? "--wave-selection-active" : "--wave-selection")
        .trim();
      context.fillRect(start, 0, Math.max(1, end - start), height);
    }
  }

  const grid = getComputedStyle(document.documentElement).getPropertyValue("--wave-grid").trim();
  context.strokeStyle = grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2 + 0.5);
  context.lineTo(width, height / 2 + 0.5);
  context.stroke();

  const waveform = waveformPeaks(width);
  if (!waveform) return;
  drawBars(context, waveform, width, height, grid);
  drawBars(playedContext, waveform, width, height, canvasColor(props.color));
}

function scheduleDraw() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(draw);
}

async function load() {
  abortController?.abort();
  abortController = new AbortController();
  loading.value = true;
  failed.value = false;
  try {
    const waveformUrl = props.url.replace(/\/stream(?:\?.*)?$/, "/waveform?points=2048");
    if (waveformUrl !== props.url) {
      const response = await fetch(apiUrl(waveformUrl), { signal: abortController.signal });
      if (!response.ok) throw new Error("Waveform peaks could not be loaded.");
      const payload = (await response.json()) as { peaks?: number[] };
      if (!Array.isArray(payload.peaks) || payload.peaks.length === 0) {
        throw new Error("Waveform peaks are unavailable.");
      }
      samples = Float32Array.from(payload.peaks);
    } else {
      const response = await fetch(apiUrl(props.url), { signal: abortController.signal });
      if (!response.ok) throw new Error("Waveform audio could not be loaded.");
      const buffer = await response.arrayBuffer();
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(buffer.slice(0));
      samples = decoded.getChannelData(0).slice();
      await audioContext.close();
    }
    await nextTick();
    draw();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) failed.value = true;
  } finally {
    loading.value = false;
  }
}

function seek(event: MouseEvent) {
  if (!props.interactive || !canvas.value) return;
  const bounds = canvas.value.getBoundingClientRect();
  emit("seek", Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)));
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleDraw);
  if (canvas.value) resizeObserver.observe(canvas.value);
  void load();
});

watch(
  () => props.url,
  () => void load(),
);
watch(() => [props.color, props.height], scheduleDraw);
watch(() => props.regions, scheduleDraw, { deep: true });

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
  abortController?.abort();
});
</script>

<template>
  <div
    class="waveform"
    :class="{ 'waveform--interactive': interactive, 'waveform--loading': loading }"
    :style="{ '--wave-progress': `${Math.max(0, Math.min(1, progress)) * 100}%` }"
  >
    <canvas
      ref="canvas"
      :style="{ height: `${height}px` }"
      :aria-label="interactive ? 'Audio waveform. Click to seek.' : 'Audio waveform'"
      @click="seek"
    />
    <span class="waveform__played" aria-hidden="true">
      <canvas ref="playedCanvas" :style="{ height: `${height}px` }" />
    </span>
    <span v-if="progress > 0" class="waveform__playhead" aria-hidden="true" />
    <span v-if="failed" class="waveform__error">Waveform unavailable</span>
  </div>
</template>
