<script setup lang="ts">
import {
  IconCheck,
  IconCloud,
  IconMicrophone2,
  IconPlayerPlay,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { GenerateGuideTracksInput, GuideCue } from "@audiotool/contracts";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { api } from "../../lib/api";
import { formatDuration } from "../../lib/format";

const props = defineProps<{
  projectId: string;
  durationMs: number;
  currentMs: number;
  playing: boolean;
}>();

const emit = defineEmits<{
  seek: [ratio: number];
  draftActive: [active: boolean];
}>();

const queryClient = useQueryClient();
const setupQuery = useQuery({
  queryKey: computed(() => ["guide-tracks", props.projectId]),
  queryFn: () => api.getGuideTracks(props.projectId),
});

const bpm = ref(120);
const beatsPerBar = ref(4);
const beatUnit = ref<2 | 4 | 8 | 16>(4);
const voiceName = ref("");
const speechRate = ref(1);
const guideVolumeDb = ref(-3);
const cues = ref<GuideCue[]>([]);
const editingCueId = ref<string | null>(null);
const cueInput = ref<HTMLInputElement | null>(null);
const hydrated = ref(false);
const savedMessage = ref("");
const previewingCueId = ref<string | null>(null);
const previewError = ref("");
const draftDirty = ref(false);
const generatedInSession = ref(false);
let previewAudio: HTMLAudioElement | null = null;
let previewSequence = 0;
const cachedCuePreviews = new Map<string, { signature: string; url: string }>();
const pendingCuePreviews = new Map<string, Promise<string>>();
const liveCueAudio = new Set<HTMLAudioElement>();
const triggeredCueIds = new Set<string>();

watch(
  () => setupQuery.data.value,
  (data) => {
    if (!data || hydrated.value) return;
    const guide = data.tracks.find((track) => track.type === "guide");
    const settings =
      guide?.settings ?? data.tracks.find((track) => track.type === "click")?.settings;
    if (settings) {
      bpm.value = settings.bpm;
      beatsPerBar.value = settings.beatsPerBar;
      beatUnit.value = settings.beatUnit as 2 | 4 | 8 | 16;
    }
    if (guide?.settings.speechRate !== undefined) speechRate.value = guide.settings.speechRate;
    if (guide?.settings.cues) cues.value = guide.settings.cues.map((cue) => ({ ...cue }));
    const savedVoice = data.voices.find((voice) => voice.name === guide?.settings.voiceName);
    const preferredVoice =
      (savedVoice?.provider !== "system" ? savedVoice : undefined) ??
      data.voices.find(
        (voice) => voice.provider === "edge" && voice.name === "en-US-JennyNeural",
      ) ??
      data.voices.find((voice) => voice.provider === "groq" && voice.name === "hannah") ??
      data.voices.find((voice) => voice.gender === "Female") ??
      data.voices[0];
    voiceName.value = preferredVoice?.name ?? "";
    hydrated.value = true;
  },
  { immediate: true },
);

watch(beatsPerBar, (next) => {
  cues.value = cues.value.map((cue) => ({ ...cue, beat: Math.min(cue.beat, next) }));
});

const selectedVoice = computed(() =>
  setupQuery.data.value?.voices.find((voice) => voice.name === voiceName.value),
);
const hasGeneratedGuide = computed(
  () =>
    generatedInSession.value ||
    Boolean(setupQuery.data.value?.tracks.some((track) => track.type === "guide")),
);
const orderedCues = computed(() =>
  [...cues.value].sort((left, right) => cueTimeMs(left) - cueTimeMs(right)),
);
const audibleCues = computed(() => orderedCues.value.filter((cue) => cue.text.trim()));
const draftActive = computed(
  () => audibleCues.value.length > 0 && (draftDirty.value || !hasGeneratedGuide.value),
);
const measureLines = computed(() => {
  if (props.durationMs <= 0 || bpm.value <= 0 || beatsPerBar.value <= 0) return [];
  const measureMs = (60_000 / bpm.value) * beatsPerBar.value;
  const measureCount = Math.min(10_000, Math.ceil(props.durationMs / measureMs));
  const minimumStride = Math.max(1, Math.ceil(measureCount / 30));
  const stride = [1, 2, 4, 8, 16, 32, 64, 128].find((value) => value >= minimumStride) ?? 128;
  const lineCount = Math.ceil(measureCount / stride);
  return Array.from({ length: lineCount }, (_, index) => {
    const measureIndex = index * stride;
    return { bar: measureIndex + 1, ratio: (measureIndex * measureMs) / props.durationMs };
  });
});
const currentRatio = computed(() =>
  props.durationMs > 0 ? Math.max(0, Math.min(1, props.currentMs / props.durationMs)) : 0,
);
const validationError = computed(() => {
  if (bpm.value < 30 || bpm.value > 300) return "BPM must be between 30 and 300.";
  if (!voiceName.value) return "No guide voice is available.";
  if (!cues.value.length) return "Click the lane to add at least one cue.";
  if (cues.value.some((cue) => !cue.text.trim())) return "Finish or delete the empty cue.";
  if (cues.value.some((cue) => cueTimeMs(cue) >= props.durationMs)) {
    return "One cue is outside the song duration.";
  }
  return "";
});

function cueTimeMs(cue: Pick<GuideCue, "bar" | "beat">) {
  const beatIndex = (cue.bar - 1) * beatsPerBar.value + (cue.beat - 1);
  return Math.round(beatIndex * (60_000 / Math.max(1, bpm.value)));
}

function cuePosition(cue: GuideCue) {
  return props.durationMs > 0
    ? `${Math.max(0, Math.min(100, (cueTimeMs(cue) / props.durationMs) * 100))}%`
    : "0%";
}

function markerAlignment(cue: GuideCue) {
  const ratio = props.durationMs > 0 ? cueTimeMs(cue) / props.durationMs : 0;
  return ratio < 0.13 ? "start" : ratio > 0.87 ? "end" : "center";
}

function beatFromTime(timeMs: number) {
  const beatMs = 60_000 / Math.max(1, bpm.value);
  const maximumBeat = Math.max(0, Math.floor(Math.max(0, props.durationMs - 1) / beatMs));
  const beatIndex = Math.min(maximumBeat, Math.max(0, Math.round(timeMs / beatMs)));
  return {
    bar: Math.floor(beatIndex / beatsPerBar.value) + 1,
    beat: (beatIndex % beatsPerBar.value) + 1,
  };
}

async function addCueAt(timeMs: number) {
  const position = beatFromTime(timeMs);
  const cue: GuideCue = { id: crypto.randomUUID(), ...position, text: "" };
  cues.value.push(cue);
  editingCueId.value = cue.id;
  savedMessage.value = "";
  await nextTick();
  cueInput.value?.focus();
}

function addAtPlayhead() {
  void addCueAt(props.currentMs);
}

function markDraftDirty() {
  draftDirty.value = true;
  preloadDraftCues();
}

function laneClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("button, input, select, .guide-cue-popover")) return;
  const lane = event.currentTarget as HTMLElement;
  const bounds = lane.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  emit("seek", ratio);
  void addCueAt(ratio * props.durationMs);
}

function laneKeydown(event: KeyboardEvent) {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  addAtPlayhead();
}

function openCue(cue: GuideCue) {
  editingCueId.value = cue.id;
  savedMessage.value = "";
  void nextTick(() => cueInput.value?.focus());
}

function closeCue(cue: GuideCue) {
  if (!cue.text.trim()) removeCue(cue.id);
  else {
    editingCueId.value = null;
    markDraftDirty();
  }
}

function cuePreviewSignature(cue: GuideCue) {
  return `${voiceName.value}\n${speechRate.value}\n${cue.text.trim()}`;
}

async function loadCuePreview(cue: GuideCue): Promise<string> {
  const signature = cuePreviewSignature(cue);
  const cached = cachedCuePreviews.get(cue.id);
  if (cached?.signature === signature) return cached.url;
  const pending = pendingCuePreviews.get(cue.id);
  if (pending) return pending;

  const request = (async () => {
    const blob = await api.previewGuideVoice(props.projectId, {
      voiceName: voiceName.value,
      text: cue.text.trim(),
      speechRate: speechRate.value,
    });
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(blob);
    cachedCuePreviews.set(cue.id, { signature, url });
    return url;
  })();
  pendingCuePreviews.set(cue.id, request);
  try {
    return await request;
  } finally {
    pendingCuePreviews.delete(cue.id);
  }
}

function preloadDraftCues() {
  for (const cue of audibleCues.value) {
    if (cue.id !== editingCueId.value) void loadCuePreview(cue).catch(() => undefined);
  }
}

function stopDraftPlayback() {
  for (const audio of liveCueAudio) {
    audio.pause();
    audio.currentTime = 0;
  }
  liveCueAudio.clear();
}

async function playDraftCue(cue: GuideCue) {
  try {
    const url = await loadCuePreview(cue);
    if (!props.playing || !draftActive.value) return;
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, 10 ** (guideVolumeDb.value / 20)));
    liveCueAudio.add(audio);
    audio.addEventListener("ended", () => liveCueAudio.delete(audio), { once: true });
    await audio.play();
  } catch (error) {
    previewError.value =
      error instanceof Error ? error.message : "A live guide cue could not be played.";
  }
}

async function previewCue(cue: GuideCue) {
  if (!cue.text.trim() || !voiceName.value) return;
  previewAudio?.pause();
  const sequence = ++previewSequence;
  previewError.value = "";
  previewingCueId.value = cue.id;
  triggeredCueIds.add(cue.id);
  savedMessage.value = "Creating an instant neural preview…";
  try {
    const url = await loadCuePreview(cue);
    previewAudio = new Audio(url);
    previewAudio.addEventListener(
      "ended",
      () => {
        if (sequence !== previewSequence) return;
        previewingCueId.value = null;
        savedMessage.value = "Cue ready. It will now play automatically with the song transport.";
      },
      { once: true },
    );
    await previewAudio.play();
  } catch (error) {
    if (sequence !== previewSequence) return;
    previewError.value = error instanceof Error ? error.message : "Cue preview failed.";
    previewingCueId.value = null;
    savedMessage.value = "";
  }
}

function placeCue(cue: GuideCue) {
  if (!cue.text.trim()) {
    removeCue(cue.id);
    return;
  }
  draftDirty.value = true;
  editingCueId.value = null;
  void previewCue(cue);
}

function removeCue(id: string) {
  if (previewingCueId.value === id) {
    previewSequence += 1;
    previewAudio?.pause();
    previewingCueId.value = null;
  }
  const cached = cachedCuePreviews.get(id);
  if (cached) URL.revokeObjectURL(cached.url);
  cachedCuePreviews.delete(id);
  pendingCuePreviews.delete(id);
  triggeredCueIds.delete(id);
  cues.value = cues.value.filter((cue) => cue.id !== id);
  if (editingCueId.value === id) editingCueId.value = null;
  draftDirty.value = true;
}

const generateMutation = useMutation({
  mutationFn: () => {
    previewSequence += 1;
    previewAudio?.pause();
    previewingCueId.value = null;
    const input: GenerateGuideTracksInput = {
      bpm: bpm.value,
      beatsPerBar: beatsPerBar.value,
      beatUnit: beatUnit.value,
      createGuide: true,
      createClick: false,
      voiceName: voiceName.value,
      speechRate: speechRate.value,
      guideVolumeDb: guideVolumeDb.value,
      clickVolumeDb: -9,
      cues: orderedCues.value.map((cue) => ({ ...cue, text: cue.text.trim() })),
    };
    return api.generateGuideTracks(props.projectId, input);
  },
  onSuccess: async () => {
    editingCueId.value = null;
    generatedInSession.value = true;
    draftDirty.value = false;
    savedMessage.value = `Guide generated at ${formatDuration(props.durationMs)} and added to the mixer.`;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["guide-tracks", props.projectId] }),
      queryClient.invalidateQueries({ queryKey: ["mix", props.projectId] }),
    ]);
  },
});

watch(
  draftActive,
  (active) => {
    emit("draftActive", active);
    if (active) preloadDraftCues();
    else stopDraftPlayback();
  },
  { immediate: true },
);

watch(
  [() => props.playing, () => props.currentMs, draftActive],
  ([isPlaying, current, active], previous) => {
    const wasPlaying = previous?.[0] ?? false;
    const previousMs = previous?.[1] ?? current;
    if (!isPlaying || !active) {
      if (!isPlaying) {
        stopDraftPlayback();
        triggeredCueIds.clear();
      }
      return;
    }

    const delta = current - previousMs;
    let lowerBound = previousMs;
    if (!wasPlaying) {
      stopDraftPlayback();
      triggeredCueIds.clear();
      lowerBound = current - 120;
    } else if (delta < -100 || delta > 500) {
      stopDraftPlayback();
      triggeredCueIds.clear();
      lowerBound = current - 90;
    }

    for (const cue of audibleCues.value) {
      const timeMs = cueTimeMs(cue);
      if (!triggeredCueIds.has(cue.id) && timeMs >= lowerBound && timeMs <= current + 80) {
        triggeredCueIds.add(cue.id);
        void playDraftCue(cue);
      }
    }
  },
  { flush: "sync" },
);

onBeforeUnmount(() => {
  emit("draftActive", false);
  previewSequence += 1;
  previewAudio?.pause();
  stopDraftPlayback();
  for (const cached of cachedCuePreviews.values()) URL.revokeObjectURL(cached.url);
  cachedCuePreviews.clear();
});
</script>

<template>
  <section class="guide-cue-overlay" aria-labelledby="guide-cue-overlay-title">
    <header class="guide-cue-overlay__header">
      <div class="guide-cue-overlay__title">
        <span><IconMicrophone2 :size="18" /></span>
        <div>
          <h2 id="guide-cue-overlay-title">Guide cues</h2>
          <small>Click the lane where the in-ear cue should speak · snaps to beat</small>
        </div>
      </div>

      <div class="guide-cue-overlay__settings">
        <label>
          <span>BPM</span>
          <input
            v-model.number="bpm"
            type="number"
            min="30"
            max="300"
            aria-label="Guide BPM"
            @change="markDraftDirty"
          />
        </label>
        <label>
          <span>Measure</span>
          <select
            v-model.number="beatsPerBar"
            aria-label="Beats per measure"
            @change="markDraftDirty"
          >
            <option :value="2">2</option>
            <option :value="3">3</option>
            <option :value="4">4</option>
            <option :value="5">5</option>
            <option :value="6">6</option>
            <option :value="7">7</option>
            <option :value="9">9</option>
            <option :value="12">12</option>
          </select>
          <select v-model.number="beatUnit" aria-label="Beat unit" @change="markDraftDirty">
            <option :value="2">/2</option>
            <option :value="4">/4</option>
            <option :value="8">/8</option>
            <option :value="16">/16</option>
          </select>
        </label>
        <label class="guide-cue-overlay__voice">
          <span>Voice</span>
          <select v-model="voiceName" aria-label="Guide voice" @change="markDraftDirty">
            <option
              v-for="voice in setupQuery.data.value?.voices ?? []"
              :key="voice.name"
              :value="voice.name"
            >
              {{ voice.displayName ?? voice.name }}
            </option>
          </select>
        </label>
        <button class="button button--secondary button--small" type="button" @click="addAtPlayhead">
          <IconPlus :size="15" /> At playhead
        </button>
        <button
          class="button button--accent button--small"
          type="button"
          :disabled="Boolean(validationError) || generateMutation.isPending.value"
          @click="generateMutation.mutate()"
        >
          <IconSparkles :size="15" />
          {{ generateMutation.isPending.value ? "Generating…" : "Generate guide" }}
        </button>
      </div>
    </header>

    <div
      class="guide-cue-lane"
      :class="{ 'guide-cue-lane--editing': editingCueId }"
      role="group"
      tabindex="0"
      aria-label="Guide cue timeline. Click to add a cue."
      @click="laneClick"
      @keydown="laneKeydown"
    >
      <i
        v-for="line in measureLines"
        :key="line.bar"
        class="guide-cue-lane__measure"
        :style="{ left: `${line.ratio * 100}%` }"
      >
        <span v-if="line.bar === 1 || line.bar % 4 === 1">{{ line.bar }}</span>
      </i>
      <span class="guide-cue-lane__playhead" :style="{ left: `${currentRatio * 100}%` }" />

      <template v-for="cue in orderedCues" :key="cue.id">
        <span
          class="guide-cue-line"
          :class="{ 'guide-cue-line--active': editingCueId === cue.id }"
          :style="{ left: cuePosition(cue) }"
          aria-hidden="true"
        />
        <div
          class="guide-cue-marker-wrap"
          :class="`guide-cue-marker-wrap--${markerAlignment(cue)}`"
          :style="{ left: cuePosition(cue) }"
        >
          <button
            class="guide-cue-marker"
            :class="{ 'guide-cue-marker--editing': editingCueId === cue.id }"
            type="button"
            :aria-label="`Edit cue ${cue.text || 'without text'} at bar ${cue.bar}, beat ${cue.beat}`"
            @click.stop="openCue(cue)"
          >
            <IconMicrophone2 :size="13" />
            <span>{{ cue.text || "New cue" }}</span>
          </button>

          <form
            v-if="editingCueId === cue.id"
            class="guide-cue-popover"
            @click.stop
            @submit.prevent="placeCue(cue)"
          >
            <header>
              <span
                >Bar {{ cue.bar }} · beat {{ cue.beat }} ·
                {{ formatDuration(cueTimeMs(cue)) }}</span
              >
              <button type="button" aria-label="Close cue editor" @click="closeCue(cue)">
                <IconX :size="15" />
              </button>
            </header>
            <label>
              <span>What should the guide say?</span>
              <input
                ref="cueInput"
                v-model="cue.text"
                maxlength="160"
                placeholder="e.g. Chorus, two, three, four"
                autocomplete="off"
                @input="draftDirty = true"
              />
            </label>
            <footer>
              <button
                class="guide-cue-delete"
                type="button"
                :aria-label="`Delete cue ${cue.text || 'without text'}`"
                @click="removeCue(cue.id)"
              >
                <IconTrash :size="15" /> Delete
              </button>
              <button
                class="guide-cue-preview"
                type="button"
                :disabled="!cue.text.trim() || previewingCueId === cue.id"
                @click="previewCue(cue)"
              >
                <IconPlayerPlay :size="14" />
                {{ previewingCueId === cue.id ? "Loading…" : "Hear again" }}
              </button>
              <button
                class="button button--primary button--small"
                type="submit"
                :disabled="!cue.text.trim() || previewingCueId === cue.id"
              >
                <IconCheck :size="14" /> Place &amp; hear
              </button>
            </footer>
          </form>
        </div>
      </template>
      <div v-if="!cues.length" class="guide-cue-lane__empty">
        <IconPlus :size="16" /> Click anywhere to place the first spoken cue
      </div>
    </div>

    <footer class="guide-cue-overlay__status">
      <span v-if="setupQuery.isPending.value">Loading guide voices…</span>
      <span
        v-else-if="selectedVoice?.provider === 'groq' || selectedVoice?.provider === 'edge'"
        class="guide-cloud-status guide-cloud-status--ready"
      >
        <IconCloud :size="14" /> {{ selectedVoice.displayName }} · {{ selectedVoice.description }}
      </span>
      <span v-else class="guide-cloud-status">
        <IconCloud :size="14" /> Windows offline speech is active. Check the ML worker to restore
        the neural guide voices.
      </span>
      <span
        >{{ cues.length }} cue{{ cues.length === 1 ? "" : "s" }} ·
        {{
          draftActive
            ? playing
              ? "live draft playing"
              : "live draft armed"
            : hasGeneratedGuide
              ? "generated guide on transport"
              : "no active guide"
        }}
        · {{ formatDuration(durationMs) }}</span
      >
    </footer>
    <p v-if="validationError && cues.length" class="guide-cue-overlay__error">
      {{ validationError }}
    </p>
    <p v-if="generateMutation.isError.value" class="guide-cue-overlay__error" role="alert">
      {{ generateMutation.error.value?.message ?? "The guide track could not be generated." }}
    </p>
    <p v-if="previewError" class="guide-cue-overlay__error" role="alert">
      {{ previewError }} You can use “Hear again” to retry without generating the guide track.
    </p>
    <p v-if="savedMessage" class="guide-cue-overlay__success" role="status">{{ savedMessage }}</p>
  </section>
</template>
