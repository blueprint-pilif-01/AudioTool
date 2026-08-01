<script setup lang="ts">
import {
  IconCut,
  IconDownload,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconTrash,
} from "@tabler/icons-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import WaveformCanvas from "../../components/audio/WaveformCanvas.vue";
import ToolHeader from "../../components/tools/ToolHeader.vue";
import RangeSlider from "../../components/ui/RangeSlider.vue";
import FileDropzone from "../../components/workflow/FileDropzone.vue";
import { api, downloadBlob, type ToolAudioFormat } from "../../lib/api";
import { formatDuration } from "../../lib/format";

interface CutRegion {
  id: number;
  startMs: number;
  endMs: number;
}

const file = ref<File | null>(null);
const originalUrl = ref("");
const renderedUrl = ref("");
const renderedBlob = ref<Blob | null>(null);
const durationMs = ref(0);
const regions = ref<CutRegion[]>([]);
const activeRegionId = ref(0);
const operation = ref<"keep" | "remove">("keep");
const fadeInMs = ref(0);
const fadeOutMs = ref(0);
const format = ref<ToolAudioFormat>("wav");
const processing = ref(false);
const localPreviewing = ref(false);
const error = ref("");
const audioElement = ref<HTMLAudioElement | null>(null);
let nextRegionId = 1;
let previewIndex = 0;

const activeRegion = computed(() =>
  regions.value.find((region) => region.id === activeRegionId.value),
);
const waveformRegions = computed(() =>
  regions.value.map((region) => ({
    startRatio: durationMs.value ? region.startMs / durationMs.value : 0,
    endRatio: durationMs.value ? region.endMs / durationMs.value : 0,
    active: region.id === activeRegionId.value,
  })),
);
const renderedFilename = computed(
  () => `${file.value?.name.replace(/\.[^.]+$/, "") ?? "audio"}-cut.${format.value}`,
);

function clearRendered() {
  if (renderedUrl.value) URL.revokeObjectURL(renderedUrl.value);
  renderedUrl.value = "";
  renderedBlob.value = null;
}

function stopLocalPreview() {
  localPreviewing.value = false;
  audioElement.value?.pause();
}

function resetFileState() {
  stopLocalPreview();
  clearRendered();
  durationMs.value = 0;
  regions.value = [];
  activeRegionId.value = 0;
  fadeInMs.value = 0;
  fadeOutMs.value = 0;
  error.value = "";
}

watch(file, (next) => {
  if (originalUrl.value) URL.revokeObjectURL(originalUrl.value);
  resetFileState();
  originalUrl.value = next ? URL.createObjectURL(next) : "";
});

watch([operation, fadeInMs, fadeOutMs, format], () => {
  stopLocalPreview();
  clearRendered();
});
watch(
  regions,
  () => {
    stopLocalPreview();
    clearRendered();
  },
  { deep: true },
);

function loadMetadata(event: Event) {
  const audio = event.currentTarget as HTMLAudioElement;
  durationMs.value = Math.max(100, Math.round(audio.duration * 1000));
  const initial: CutRegion = { id: nextRegionId++, startMs: 0, endMs: durationMs.value };
  regions.value = [initial];
  activeRegionId.value = initial.id;
}

function setRegionStart(region: CutRegion, value: number) {
  region.startMs = Math.max(0, Math.min(Math.round(value), region.endMs - 10));
}

function setRegionEnd(region: CutRegion, value: number) {
  region.endMs = Math.min(durationMs.value, Math.max(Math.round(value), region.startMs + 10));
}

function addRegion() {
  const active = activeRegion.value;
  if (!active || active.endMs - active.startMs < 1_000) return;
  const originalEnd = active.endMs;
  const midpoint = Math.round((active.startMs + active.endMs) / 2);
  active.endMs = midpoint - 250;
  const created: CutRegion = {
    id: nextRegionId++,
    startMs: midpoint + 250,
    endMs: originalEnd,
  };
  regions.value.push(created);
  activeRegionId.value = created.id;
}

function removeRegion(id: number) {
  if (regions.value.length <= 1) return;
  const index = regions.value.findIndex((region) => region.id === id);
  if (index < 0) return;
  regions.value.splice(index, 1);
  activeRegionId.value = regions.value[Math.max(0, index - 1)]!.id;
}

function mergedSelections(): Array<{ startMs: number; endMs: number }> {
  const ordered = regions.value
    .map(({ startMs, endMs }) => ({ startMs, endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const region of ordered) {
    const previous = merged.at(-1);
    if (previous && region.startMs <= previous.endMs)
      previous.endMs = Math.max(previous.endMs, region.endMs);
    else merged.push({ ...region });
  }
  return merged;
}

function previewIntervals(): Array<{ startMs: number; endMs: number }> {
  const selected = mergedSelections();
  if (operation.value === "keep") return selected;
  const kept: Array<{ startMs: number; endMs: number }> = [];
  let cursor = 0;
  for (const region of selected) {
    if (region.startMs > cursor) kept.push({ startMs: cursor, endMs: region.startMs });
    cursor = region.endMs;
  }
  if (cursor < durationMs.value) kept.push({ startMs: cursor, endMs: durationMs.value });
  return kept;
}

async function previewLocally() {
  const audio = audioElement.value;
  const intervals = previewIntervals();
  if (!audio || intervals.length === 0) {
    error.value = "This selection would produce an empty file.";
    return;
  }
  error.value = "";
  previewIndex = 0;
  localPreviewing.value = true;
  audio.currentTime = intervals[0]!.startMs / 1000;
  await audio.play();
}

function continueLocalPreview() {
  if (!localPreviewing.value || !audioElement.value) return;
  const intervals = previewIntervals();
  const interval = intervals[previewIndex];
  if (!interval || audioElement.value.currentTime * 1000 < interval.endMs - 20) return;
  previewIndex += 1;
  const next = intervals[previewIndex];
  if (!next) {
    stopLocalPreview();
    return;
  }
  audioElement.value.currentTime = next.startMs / 1000;
  void audioElement.value.play();
}

async function renderCut() {
  if (!file.value || processing.value || regions.value.length === 0) return;
  processing.value = true;
  error.value = "";
  stopLocalPreview();
  clearRendered();
  try {
    renderedBlob.value = await api.cutAudio(file.value, {
      regions: regions.value.map(({ startMs, endMs }) => ({ startMs, endMs })),
      operation: operation.value,
      fadeInMs: fadeInMs.value,
      fadeOutMs: fadeOutMs.value,
      format: format.value,
    });
    renderedUrl.value = URL.createObjectURL(renderedBlob.value);
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "The selected regions could not be rendered.";
  } finally {
    processing.value = false;
  }
}

function download() {
  if (renderedBlob.value) downloadBlob(renderedBlob.value, renderedFilename.value);
}

onBeforeUnmount(() => {
  if (originalUrl.value) URL.revokeObjectURL(originalUrl.value);
  clearRendered();
});
</script>

<template>
  <div class="tool-page">
    <ToolHeader
      title="Audio cutter"
      description="Keep or remove precise regions, audition the sequence locally, then render WAV, MP3, or FLAC."
    />
    <section class="tool-editor surface">
      <FileDropzone v-if="!file" v-model="file" :disabled="processing" />
      <template v-else>
        <div class="tool-editor__file">
          <div>
            <strong>{{ file.name }}</strong
            ><span>{{ formatDuration(durationMs) }}</span>
          </div>
          <button class="button button--secondary button--small" type="button" @click="file = null">
            Change file
          </button>
        </div>
        <audio
          ref="audioElement"
          :src="originalUrl"
          controls
          preload="metadata"
          @loadedmetadata="loadMetadata"
          @timeupdate="continueLocalPreview"
          @ended="stopLocalPreview"
        />
        <WaveformCanvas
          v-if="durationMs"
          :url="originalUrl"
          :height="118"
          :regions="waveformRegions"
        />

        <div class="cut-mode-bar">
          <fieldset class="segmented-control">
            <legend>Selection action</legend>
            <label><input v-model="operation" type="radio" value="keep" /> Keep selected</label>
            <label><input v-model="operation" type="radio" value="remove" /> Remove selected</label>
          </fieldset>
          <button
            class="button button--secondary button--small"
            type="button"
            :disabled="!activeRegion || activeRegion.endMs - activeRegion.startMs < 1000"
            @click="addRegion"
          >
            <IconPlus :size="16" /> Split into another region
          </button>
        </div>

        <ol class="cut-region-list" aria-label="Selected audio regions">
          <li
            v-for="(region, index) in regions"
            :key="region.id"
            :class="{ 'cut-region-list__item--active': region.id === activeRegionId }"
          >
            <button
              class="cut-region-list__select"
              type="button"
              :aria-pressed="region.id === activeRegionId"
              @click="activeRegionId = region.id"
            >
              Region {{ index + 1 }}
            </button>
            <label>
              <span>Start (ms)</span>
              <input
                class="input"
                type="number"
                min="0"
                :max="region.endMs - 10"
                step="10"
                :value="region.startMs"
                @input="setRegionStart(region, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <label>
              <span>End (ms)</span>
              <input
                class="input"
                type="number"
                :min="region.startMs + 10"
                :max="durationMs"
                step="10"
                :value="region.endMs"
                @input="setRegionEnd(region, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <output>{{ formatDuration(region.endMs - region.startMs) }}</output>
            <button
              class="icon-button"
              type="button"
              :disabled="regions.length === 1"
              :aria-label="`Remove region ${index + 1}`"
              @click="removeRegion(region.id)"
            >
              <IconTrash :size="17" />
            </button>
          </li>
        </ol>

        <div v-if="activeRegion" class="range-editor">
          <label>
            <span
              >Active start <output>{{ formatDuration(activeRegion.startMs) }}</output></span
            >
            <RangeSlider
              :model-value="activeRegion.startMs"
              :min="0"
              :max="Math.max(0, activeRegion.endMs - 10)"
              :step="10"
              aria-label="Active region start"
              @update:model-value="setRegionStart(activeRegion, $event)"
            />
          </label>
          <label>
            <span
              >Active end <output>{{ formatDuration(activeRegion.endMs) }}</output></span
            >
            <RangeSlider
              :model-value="activeRegion.endMs"
              :min="activeRegion.startMs + 10"
              :max="durationMs"
              :step="10"
              aria-label="Active region end"
              @update:model-value="setRegionEnd(activeRegion, $event)"
            />
          </label>
        </div>

        <div class="cut-readout cut-readout--advanced">
          <div>
            <span>Regions</span><strong>{{ regions.length }}</strong>
          </div>
          <label class="field">
            <span>Fade in (ms)</span>
            <input v-model.number="fadeInMs" class="input" type="number" min="0" step="50" />
          </label>
          <label class="field">
            <span>Fade out (ms)</span>
            <input v-model.number="fadeOutMs" class="input" type="number" min="0" step="50" />
          </label>
          <label class="field">
            <span>Format</span>
            <select v-model="format" class="select">
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
              <option value="flac">FLAC</option>
            </select>
          </label>
        </div>

        <div v-if="renderedUrl" class="tool-preview" aria-live="polite">
          <div>
            <strong>Rendered preview</strong><span>{{ renderedFilename }}</span>
          </div>
          <audio :src="renderedUrl" controls preload="metadata" />
        </div>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <div class="tool-actions">
          <button
            class="button button--secondary"
            type="button"
            :disabled="!durationMs"
            @click="localPreviewing ? stopLocalPreview() : previewLocally()"
          >
            <IconPlayerStop v-if="localPreviewing" :size="17" />
            <IconPlayerPlay v-else :size="17" />
            {{ localPreviewing ? "Stop preview" : "Preview selection" }}
          </button>
          <button
            class="button button--accent"
            type="button"
            :disabled="processing"
            @click="renderCut"
          >
            <IconCut :size="18" /> {{ processing ? "Rendering" : `Render ${format.toUpperCase()}` }}
          </button>
          <button
            v-if="renderedBlob"
            class="button button--primary"
            type="button"
            @click="download"
          >
            <IconDownload :size="17" /> Download
          </button>
        </div>
      </template>
    </section>
  </div>
</template>
