<script setup lang="ts">
import { IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconVolume } from "@tabler/icons-vue";
import { ref, watch } from "vue";

import { apiUrl } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import RangeSlider from "../ui/RangeSlider.vue";

const props = defineProps<{
  src: string;
  label: string;
}>();

const audio = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const currentMs = ref(0);
const durationMs = ref(0);
const volume = ref(0.82);

watch(volume, (value) => {
  if (audio.value) audio.value.volume = value;
});

watch(
  () => props.src,
  () => {
    playing.value = false;
    currentMs.value = 0;
    durationMs.value = 0;
  },
);

async function toggle() {
  if (!audio.value) return;
  if (playing.value) {
    audio.value.pause();
    return;
  }
  try {
    await audio.value.play();
  } catch {
    playing.value = false;
  }
}

function seek(milliseconds: number) {
  if (!audio.value || durationMs.value <= 0) return;
  audio.value.currentTime = Math.max(0, Math.min(durationMs.value, milliseconds)) / 1000;
  currentMs.value = Math.round(audio.value.currentTime * 1000);
}

function restart() {
  seek(0);
}
</script>

<template>
  <div class="mini-player" :aria-label="`${label} preview`">
    <button
      class="mini-player__button"
      type="button"
      :aria-label="`Restart ${label}`"
      @click="restart"
    >
      <IconPlayerSkipBack :size="17" />
    </button>
    <button
      class="mini-player__button mini-player__button--primary"
      type="button"
      :aria-label="playing ? `Pause ${label}` : `Play ${label}`"
      @click="toggle"
    >
      <IconPlayerPause v-if="playing" :size="19" />
      <IconPlayerPlay v-else :size="19" />
    </button>
    <output>{{ formatDuration(currentMs) }}</output>
    <RangeSlider
      class="mini-player__seek"
      :model-value="currentMs"
      :min="0"
      :max="Math.max(1, durationMs)"
      :step="20"
      :aria-label="`${label} playback position`"
      :aria-value-text="`${formatDuration(currentMs)} of ${formatDuration(durationMs)}`"
      @update:model-value="seek"
    />
    <output>{{ formatDuration(durationMs) }}</output>
    <label class="mini-player__volume">
      <IconVolume :size="17" />
      <span class="visually-hidden">{{ label }} preview volume</span>
      <RangeSlider
        v-model="volume"
        :min="0"
        :max="1"
        :step="0.01"
        :aria-label="`${label} preview volume`"
        :aria-value-text="`${Math.round(volume * 100)} percent`"
      />
      <output>{{ Math.round(volume * 100) }}%</output>
    </label>
    <audio
      ref="audio"
      :src="apiUrl(src)"
      preload="metadata"
      @loadedmetadata="
        durationMs = Number.isFinite(($event.target as HTMLAudioElement).duration)
          ? Math.round(($event.target as HTMLAudioElement).duration * 1000)
          : 0
      "
      @durationchange="
        durationMs = Number.isFinite(($event.target as HTMLAudioElement).duration)
          ? Math.round(($event.target as HTMLAudioElement).duration * 1000)
          : durationMs
      "
      @timeupdate="currentMs = Math.round(($event.target as HTMLAudioElement).currentTime * 1000)"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
    />
  </div>
</template>
