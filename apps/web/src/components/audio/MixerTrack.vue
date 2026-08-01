<script setup lang="ts">
import {
  IconDownload,
  IconGripVertical,
  IconHeadphones,
  IconRestore,
  IconSettings,
  IconTrash,
  IconVolume,
  IconVolumeOff,
  IconWaveSine,
} from "@tabler/icons-vue";
import { computed } from "vue";

import RangeSlider from "../ui/RangeSlider.vue";
import { apiUrl } from "../../lib/api";
import type { MixerTrackState } from "../../types/mixer";
import WaveformCanvas from "./WaveformCanvas.vue";

const props = defineProps<{
  track: MixerTrackState;
  timelineDurationMs: number;
  sourceDurationMs: number;
  currentRatio: number;
  registerAudio: (trackId: string, element: HTMLAudioElement | null) => void;
  registerMeter: (trackId: string, element: HTMLElement | null) => void;
  downloadUrl: string | undefined;
}>();

const emit = defineEmits<{
  update: [track: MixerTrackState];
  seek: [ratio: number];
  remove: [track: MixerTrackState];
  reset: [track: MixerTrackState];
}>();

const left = computed(() =>
  props.timelineDurationMs > 0
    ? Math.min(95, (props.track.startMs / props.timelineDurationMs) * 100)
    : 0,
);
const trimTotal = computed(() => props.track.trimStartMs + props.track.trimEndMs);
const effectiveDurationMs = computed(() => Math.max(0, props.sourceDurationMs - trimTotal.value));
const playbackUrl = computed(() =>
  apiUrl(
    props.track.trackType === "stem"
      ? props.track.streamUrl.replace(/\/stream$/, "/playback")
      : props.track.streamUrl,
  ),
);
const width = computed(() =>
  props.timelineDurationMs > 0
    ? Math.max(5, (effectiveDurationMs.value / props.timelineDurationMs) * 100)
    : 100,
);

function patch(update: Partial<MixerTrackState>) {
  emit("update", { ...props.track, ...update });
}

function startDrag(event: PointerEvent) {
  if (!(event.currentTarget instanceof HTMLElement) || props.timelineDurationMs <= 0) return;
  const clip = event.currentTarget;
  const timeline = clip.parentElement;
  if (!timeline) return;
  const startX = event.clientX;
  const startMs = props.track.startMs;
  clip.setPointerCapture(event.pointerId);

  const onMove = (move: PointerEvent) => {
    const delta = move.clientX - startX;
    const maxDelta = timeline.clientWidth * (1 - left.value / 100 - width.value / 100);
    const bounded = Math.max(-(left.value / 100) * timeline.clientWidth, Math.min(maxDelta, delta));
    clip.style.transform = `translateX(${bounded}px)`;
  };
  const onEnd = (up: PointerEvent) => {
    const delta = up.clientX - startX;
    const next = Math.max(
      0,
      Math.min(
        props.timelineDurationMs - effectiveDurationMs.value,
        startMs + (delta / timeline.clientWidth) * props.timelineDurationMs,
      ),
    );
    clip.style.transform = "";
    clip.removeEventListener("pointermove", onMove);
    clip.removeEventListener("pointerup", onEnd);
    clip.removeEventListener("pointercancel", onEnd);
    patch({ startMs: Math.round(next) });
  };
  clip.addEventListener("pointermove", onMove);
  clip.addEventListener("pointerup", onEnd);
  clip.addEventListener("pointercancel", onEnd);
}
</script>

<template>
  <article class="mixer-track" :style="{ '--track-color': track.color }">
    <header class="mixer-track__controls">
      <span class="track-grip" aria-hidden="true"><IconGripVertical :size="17" /></span>
      <span class="track-icon"><IconWaveSine :size="19" /></span>
      <div class="track-name">
        <strong>{{ track.label }}</strong>
        <span>{{
          track.trackType === "guide"
            ? "Spoken guide"
            : track.trackType === "click"
              ? "Metronome"
              : track.trackType === "vocal_breakdown"
                ? "Vocal learning track · experimental"
                : track.stemId
                  ? "Separated stem"
                  : "Audio track"
        }}</span>
      </div>
      <div class="track-toggle-group" aria-label="Track monitoring">
        <button
          class="track-toggle"
          :class="{ active: track.muted }"
          type="button"
          :aria-pressed="track.muted"
          :aria-label="`${track.muted ? 'Unmute' : 'Mute'} ${track.label}`"
          @click="patch({ muted: !track.muted })"
        >
          <IconVolumeOff v-if="track.muted" :size="16" />
          <IconVolume v-else :size="16" />
          M
        </button>
        <button
          class="track-toggle"
          :class="{ active: track.solo }"
          type="button"
          :aria-pressed="track.solo"
          :aria-label="`${track.solo ? 'Disable solo for' : 'Solo'} ${track.label}`"
          @click="patch({ solo: !track.solo })"
        >
          <IconHeadphones :size="16" /> S
        </button>
      </div>
      <label class="track-level">
        <span>Level</span>
        <RangeSlider
          :model-value="track.volumeDb"
          :min="-60"
          :max="12"
          :step="0.5"
          :aria-label="`${track.label} volume`"
          :aria-value-text="`${track.volumeDb.toFixed(1)} decibels`"
          color="var(--track-color)"
          @update:model-value="patch({ volumeDb: $event })"
        />
        <output>{{ track.volumeDb > 0 ? "+" : "" }}{{ track.volumeDb.toFixed(1) }} dB</output>
      </label>
      <div
        class="track-meter"
        role="meter"
        aria-label="Track output level"
        aria-valuemin="-60"
        aria-valuemax="0"
        aria-valuenow="-60"
      >
        <span
          :ref="
            (element) =>
              registerMeter(track.id ?? track.audioAssetId, element as HTMLElement | null)
          "
        />
      </div>
      <div class="track-actions">
        <button
          class="icon-button"
          type="button"
          :aria-label="`Reset ${track.label} controls`"
          @click="emit('reset', track)"
        >
          <IconRestore :size="17" />
        </button>
        <button
          class="icon-button"
          type="button"
          :aria-label="`Remove ${track.label} from mix`"
          @click="emit('remove', track)"
        >
          <IconTrash :size="17" />
        </button>
        <a
          v-if="downloadUrl"
          class="icon-button"
          :href="downloadUrl"
          :download="`${track.label}.wav`"
          :aria-label="`Download ${track.label}`"
        >
          <IconDownload :size="18" />
        </a>
      </div>
    </header>

    <div class="mixer-track__timeline">
      <div
        class="track-clip"
        :style="{ left: `${left}%`, width: `${width}%` }"
        @pointerdown="startDrag"
      >
        <WaveformCanvas
          :url="track.streamUrl"
          :progress="Math.max(0, Math.min(1, (currentRatio - left / 100) / (width / 100)))"
          :color="track.color"
          :height="76"
          interactive
          @seek="(ratio) => emit('seek', left / 100 + ratio * (width / 100))"
        />
      </div>
      <span class="track-start" :style="{ left: `${left}%` }"
        >{{ (track.startMs / 1000).toFixed(1) }}s</span
      >
    </div>

    <details class="track-details">
      <summary><IconSettings :size="16" /> Pan, trim and fades</summary>
      <div class="track-details__grid">
        <label class="track-parameter">
          <span
            >Pan
            <output>{{
              track.pan === 0
                ? "C"
                : track.pan < 0
                  ? `L${Math.round(Math.abs(track.pan) * 100)}`
                  : `R${Math.round(track.pan * 100)}`
            }}</output></span
          >
          <RangeSlider
            :model-value="track.pan"
            :min="-1"
            :max="1"
            :step="0.01"
            :aria-label="`${track.label} pan`"
            color="var(--track-color)"
            @update:model-value="patch({ pan: $event })"
          />
        </label>
        <label class="track-parameter">
          <span
            >Trim start <output>{{ (track.trimStartMs / 1000).toFixed(1) }}s</output></span
          >
          <RangeSlider
            :model-value="track.trimStartMs"
            :min="0"
            :max="Math.max(0, sourceDurationMs - track.trimEndMs - 100)"
            :step="100"
            :aria-label="`${track.label} trim start`"
            color="var(--track-color)"
            @update:model-value="patch({ trimStartMs: $event })"
          />
        </label>
        <label class="track-parameter">
          <span
            >Trim end <output>{{ (track.trimEndMs / 1000).toFixed(1) }}s</output></span
          >
          <RangeSlider
            :model-value="track.trimEndMs"
            :min="0"
            :max="Math.max(0, sourceDurationMs - track.trimStartMs - 100)"
            :step="100"
            :aria-label="`${track.label} trim end`"
            color="var(--track-color)"
            @update:model-value="patch({ trimEndMs: $event })"
          />
        </label>
        <label class="track-parameter">
          <span
            >Fade in <output>{{ (track.fadeInMs / 1000).toFixed(1) }}s</output></span
          >
          <RangeSlider
            :model-value="track.fadeInMs"
            :min="0"
            :max="Math.min(10000, effectiveDurationMs / 2)"
            :step="100"
            :aria-label="`${track.label} fade in`"
            color="var(--track-color)"
            @update:model-value="patch({ fadeInMs: $event })"
          />
        </label>
        <label class="track-parameter">
          <span
            >Fade out <output>{{ (track.fadeOutMs / 1000).toFixed(1) }}s</output></span
          >
          <RangeSlider
            :model-value="track.fadeOutMs"
            :min="0"
            :max="Math.min(10000, effectiveDurationMs / 2)"
            :step="100"
            :aria-label="`${track.label} fade out`"
            color="var(--track-color)"
            @update:model-value="patch({ fadeOutMs: $event })"
          />
        </label>
      </div>
    </details>

    <audio
      :ref="
        (element) =>
          registerAudio(track.id ?? track.audioAssetId, element as HTMLAudioElement | null)
      "
      :src="playbackUrl"
      preload="metadata"
    />
  </article>
</template>
