<script setup lang="ts">
import {
  IconArrowDown,
  IconArrowUp,
  IconDownload,
  IconGripVertical,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import ToolHeader from "../../components/tools/ToolHeader.vue";
import FileDropzone from "../../components/workflow/FileDropzone.vue";
import { api, downloadBlob, type ToolAudioFormat } from "../../lib/api";
import { formatBytes, formatDuration } from "../../lib/format";

interface JoinItem {
  id: number;
  file: File;
  url: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
}

const items = ref<JoinItem[]>([]);
const transition = ref<"none" | "pause" | "crossfade">("none");
const transitionMs = ref(0);
const normalize = ref(false);
const format = ref<ToolAudioFormat>("wav");
const processing = ref(false);
const error = ref("");
const renderedBlob = ref<Blob | null>(null);
const renderedUrl = ref("");
const dragIndex = ref<number | null>(null);
let nextItemId = 1;

const totalDurationMs = computed(() => {
  const clips = items.value.reduce(
    (total, item) => total + Math.max(0, item.trimEndMs - item.trimStartMs),
    0,
  );
  const transitions = Math.max(0, items.value.length - 1) * transitionMs.value;
  if (transition.value === "pause") return clips + transitions;
  if (transition.value === "crossfade") return Math.max(0, clips - transitions);
  return clips;
});
const canRender = computed(
  () =>
    items.value.length >= 2 &&
    items.value.every((item) => item.durationMs > 0 && item.trimEndMs > item.trimStartMs) &&
    (transition.value !== "crossfade" ||
      items.value.every((item) => item.trimEndMs - item.trimStartMs > transitionMs.value)),
);
const renderedFilename = computed(() => `joined-audio.${format.value}`);

function clearRendered() {
  if (renderedUrl.value) URL.revokeObjectURL(renderedUrl.value);
  renderedUrl.value = "";
  renderedBlob.value = null;
}

function loadDuration(item: JoinItem) {
  const audio = new Audio(item.url);
  audio.addEventListener(
    "loadedmetadata",
    () => {
      item.durationMs = Math.max(100, Math.round(audio.duration * 1000));
      item.trimEndMs = item.durationMs;
    },
    { once: true },
  );
  audio.addEventListener(
    "error",
    () => {
      error.value = `${item.file.name} could not be decoded in the browser.`;
    },
    { once: true },
  );
}

function addFiles(incoming: File[]) {
  error.value = "";
  for (const file of incoming) {
    const item: JoinItem = {
      id: nextItemId++,
      file,
      url: URL.createObjectURL(file),
      durationMs: 0,
      trimStartMs: 0,
      trimEndMs: 0,
    };
    items.value.push(item);
    loadDuration(item);
  }
  clearRendered();
}

function move(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= items.value.length) return;
  const item = items.value[index];
  if (!item) return;
  items.value.splice(index, 1);
  items.value.splice(target, 0, item);
  clearRendered();
}

function dropAt(index: number) {
  const from = dragIndex.value;
  dragIndex.value = null;
  if (from === null || from === index) return;
  const item = items.value[from];
  if (!item) return;
  items.value.splice(from, 1);
  items.value.splice(index, 0, item);
  clearRendered();
}

function removeItem(index: number) {
  const [removed] = items.value.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.url);
  clearRendered();
}

function setTrimStart(item: JoinItem, value: number) {
  item.trimStartMs = Math.max(0, Math.min(Math.round(value), item.trimEndMs - 10));
  clearRendered();
}

function setTrimEnd(item: JoinItem, value: number) {
  item.trimEndMs = Math.min(item.durationMs, Math.max(Math.round(value), item.trimStartMs + 10));
  clearRendered();
}

watch([transition, transitionMs, normalize, format], clearRendered);

async function renderJoin() {
  if (!canRender.value || processing.value) return;
  processing.value = true;
  error.value = "";
  clearRendered();
  try {
    renderedBlob.value = await api.joinAudio(
      items.value.map((item) => item.file),
      {
        trims: items.value.map((item) => ({
          startMs: item.trimStartMs,
          endMs: item.trimEndMs,
        })),
        transition: transition.value,
        transitionMs: transitionMs.value,
        normalize: normalize.value,
        format: format.value,
      },
    );
    renderedUrl.value = URL.createObjectURL(renderedBlob.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The audio files could not be joined.";
  } finally {
    processing.value = false;
  }
}

function download() {
  if (renderedBlob.value) downloadBlob(renderedBlob.value, renderedFilename.value);
}

onBeforeUnmount(() => {
  for (const item of items.value) URL.revokeObjectURL(item.url);
  clearRendered();
});
</script>

<template>
  <div class="tool-page">
    <ToolHeader
      title="Audio joiner"
      description="Drag clips into order, trim each one, choose a pause or crossfade, then preview and export."
    />
    <section class="tool-editor surface">
      <FileDropzone multiple :disabled="processing" @files="addFiles" />
      <ol v-if="items.length" class="join-list join-list--advanced" aria-label="Joiner clips">
        <li
          v-for="(item, index) in items"
          :key="item.id"
          draggable="true"
          :class="{ 'join-list__item--dragging': dragIndex === index }"
          @dragstart="dragIndex = index"
          @dragend="dragIndex = null"
          @dragover.prevent
          @drop.prevent="dropAt(index)"
        >
          <IconGripVertical :size="18" class="join-list__grip" aria-hidden="true" />
          <span class="join-list__index">{{ index + 1 }}</span>
          <span class="join-list__file">
            <strong>{{ item.file.name }}</strong>
            <small>{{ formatBytes(item.file.size) }} / {{ formatDuration(item.durationMs) }}</small>
          </span>
          <label class="join-list__trim">
            <span>Start ms</span>
            <input
              class="input"
              type="number"
              min="0"
              :max="item.trimEndMs - 10"
              step="10"
              :value="item.trimStartMs"
              :aria-label="`${item.file.name} trim start`"
              @input="setTrimStart(item, Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <label class="join-list__trim">
            <span>End ms</span>
            <input
              class="input"
              type="number"
              :min="item.trimStartMs + 10"
              :max="item.durationMs"
              step="10"
              :value="item.trimEndMs"
              :aria-label="`${item.file.name} trim end`"
              @input="setTrimEnd(item, Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <div class="join-list__actions">
            <button
              class="icon-button icon-button--neutral"
              type="button"
              :disabled="index === 0"
              :aria-label="`Move ${item.file.name} up`"
              @click="move(index, -1)"
            >
              <IconArrowUp :size="17" />
            </button>
            <button
              class="icon-button icon-button--neutral"
              type="button"
              :disabled="index === items.length - 1"
              :aria-label="`Move ${item.file.name} down`"
              @click="move(index, 1)"
            >
              <IconArrowDown :size="17" />
            </button>
            <button
              class="icon-button"
              type="button"
              :aria-label="`Remove ${item.file.name}`"
              @click="removeItem(index)"
            >
              <IconTrash :size="17" />
            </button>
          </div>
        </li>
      </ol>

      <div v-if="items.length" class="join-options">
        <label class="field">
          <span>Between clips</span>
          <select v-model="transition" class="select">
            <option value="none">Direct join</option>
            <option value="pause">Pause</option>
            <option value="crossfade">Crossfade</option>
          </select>
        </label>
        <label class="field">
          <span>Transition (ms)</span>
          <input
            v-model.number="transitionMs"
            class="input"
            type="number"
            min="0"
            max="5000"
            step="100"
            :disabled="transition === 'none'"
          />
        </label>
        <label class="field">
          <span>Output format</span>
          <select v-model="format" class="select">
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
            <option value="flac">FLAC</option>
          </select>
        </label>
        <label class="join-normalize">
          <input v-model="normalize" type="checkbox" />
          <span><strong>Normalize clips</strong><small>Target -16 LUFS before joining</small></span>
        </label>
        <div class="join-duration">
          <span>Estimated output</span><strong>{{ formatDuration(totalDurationMs) }}</strong>
        </div>
      </div>

      <p v-if="items.length === 1" class="error-banner">Add at least one more audio file.</p>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <div v-if="renderedUrl" class="tool-preview" aria-live="polite">
        <div>
          <strong>Joined preview</strong><span>{{ renderedFilename }}</span>
        </div>
        <audio :src="renderedUrl" controls preload="metadata" />
      </div>
      <div v-if="items.length" class="tool-actions">
        <button
          class="button button--accent"
          type="button"
          :disabled="!canRender || processing"
          @click="renderJoin"
        >
          <IconPlayerPlay :size="18" />
          {{ processing ? "Rendering" : `Render ${items.length} clips` }}
        </button>
        <button v-if="renderedBlob" class="button button--primary" type="button" @click="download">
          <IconDownload :size="18" /> Download {{ format.toUpperCase() }}
        </button>
      </div>
    </section>
  </div>
</template>
