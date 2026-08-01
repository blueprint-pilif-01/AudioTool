<script setup lang="ts">
import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconHeadphones,
  IconMetronome,
  IconMicrophone2,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconWand,
} from "@tabler/icons-vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { GenerateGuideTracksInput, GuideCue } from "@audiotool/contracts";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import MiniAudioPlayer from "../components/audio/MiniAudioPlayer.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import RangeSlider from "../components/ui/RangeSlider.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api } from "../lib/api";
import { formatDuration } from "../lib/format";

const route = useRoute();
const queryClient = useQueryClient();
const projectId = computed(() => String(route.params.id));
const projectQuery = useQuery({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () => api.getProject(projectId.value),
});
const setupQuery = useQuery({
  queryKey: computed(() => ["guide-tracks", projectId.value]),
  queryFn: () => api.getGuideTracks(projectId.value),
});

const bpm = ref(120);
const beatsPerBar = ref(4);
const beatUnit = ref<2 | 4 | 8 | 16>(4);
const createGuide = ref(true);
const createClick = ref(true);
const voiceName = ref("");
const speechRate = ref(0);
const guideVolumeDb = ref(-3);
const clickVolumeDb = ref(-9);
const cues = ref<GuideCue[]>([{ id: crypto.randomUUID(), bar: 1, beat: 1, text: "Intro" }]);
const hydrated = ref(false);
const generatedNow = ref(false);
const previewingCueId = ref<string | null>(null);
const previewError = ref("");
let previewAudio: HTMLAudioElement | null = null;
let previewUrl = "";
const cuePresets = ["Intro", "Verse", "Chorus", "Bridge", "Instrumental", "Ending"];

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
    if (guide?.settings.voiceName) voiceName.value = guide.settings.voiceName;
    if (guide?.settings.speechRate !== undefined) speechRate.value = guide.settings.speechRate;
    if (guide?.settings.cues?.length) cues.value = guide.settings.cues.map((cue) => ({ ...cue }));
    const savedVoice = data.voices.find((voice) => voice.name === voiceName.value);
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

const durationMs = computed(() => setupQuery.data.value?.durationMs ?? 0);
const estimatedBars = computed(() => {
  if (durationMs.value <= 0 || bpm.value <= 0 || beatsPerBar.value <= 0) return 0;
  return Math.max(1, Math.ceil(durationMs.value / (60_000 / bpm.value) / beatsPerBar.value));
});
const orderedCues = computed(() =>
  [...cues.value].sort((left, right) => cueTimeMs(left) - cueTimeMs(right)),
);
const validationError = computed(() => {
  if (!createGuide.value && !createClick.value)
    return "Select the guide track, the click track, or both.";
  if (!Number.isFinite(bpm.value) || bpm.value < 30 || bpm.value > 300) {
    return "BPM must be between 30 and 300.";
  }
  if (createGuide.value && !voiceName.value)
    return "No guide voice is available. Check the ML worker connection.";
  if (createGuide.value && cues.value.length === 0) return "Add at least one spoken cue.";
  if (createGuide.value && cues.value.some((cue) => !cue.text.trim()))
    return "Every guide cue needs spoken text.";
  const outside = createGuide.value
    ? cues.value.find((cue) => cueTimeMs(cue) >= durationMs.value)
    : undefined;
  return outside
    ? `Bar ${outside.bar}, beat ${outside.beat} is outside this ${formatDuration(durationMs.value)} song.`
    : "";
});
const resultTracks = computed(
  () => generateMutation.data.value?.tracks ?? setupQuery.data.value?.tracks ?? [],
);
const selectedVoice = computed(() =>
  setupQuery.data.value?.voices.find((voice) => voice.name === voiceName.value),
);

function cueTimeMs(cue: Pick<GuideCue, "bar" | "beat">) {
  if (bpm.value <= 0) return 0;
  return Math.round(((cue.bar - 1) * beatsPerBar.value + cue.beat - 1) * (60_000 / bpm.value));
}

function addCue(text = "") {
  const last = orderedCues.value.at(-1);
  cues.value.push({
    id: crypto.randomUUID(),
    bar: last ? Math.min(10_000, last.bar + 4) : 1,
    beat: 1,
    text,
  });
}

function removeCue(id: string) {
  cues.value = cues.value.filter((cue) => cue.id !== id);
}

async function previewCue(cue: GuideCue) {
  if (!cue.text.trim() || !voiceName.value) return;
  previewAudio?.pause();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewError.value = "";
  previewingCueId.value = cue.id;
  try {
    const blob = await api.previewGuideVoice(projectId.value, {
      voiceName: voiceName.value,
      text: cue.text.trim(),
      speechRate: speechRate.value,
    });
    previewUrl = URL.createObjectURL(blob);
    previewAudio = new Audio(previewUrl);
    previewAudio.addEventListener("ended", () => (previewingCueId.value = null), { once: true });
    await previewAudio.play();
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : "Voice preview failed.";
    previewingCueId.value = null;
  }
}

const generateMutation = useMutation({
  mutationFn: () => {
    const input: GenerateGuideTracksInput = {
      bpm: bpm.value,
      beatsPerBar: beatsPerBar.value,
      beatUnit: beatUnit.value,
      createGuide: createGuide.value,
      createClick: createClick.value,
      ...(voiceName.value ? { voiceName: voiceName.value } : {}),
      speechRate: speechRate.value,
      guideVolumeDb: guideVolumeDb.value,
      clickVolumeDb: clickVolumeDb.value,
      cues: orderedCues.value.map((cue) => ({ ...cue, text: cue.text.trim() })),
    };
    return api.generateGuideTracks(projectId.value, input);
  },
  onSuccess: async () => {
    generatedNow.value = true;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["guide-tracks", projectId.value] }),
      queryClient.invalidateQueries({ queryKey: ["mix", projectId.value] }),
    ]);
  },
});

onBeforeUnmount(() => {
  previewAudio?.pause();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});
</script>

<template>
  <div class="guide-page">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Guide & click'"
      description="Create the spoken cues musicians hear in their in-ears and a metronome locked to the song. Both are added to the mixer as separate tracks."
    >
      <template #actions>
        <RouterLink class="button button--secondary" :to="`/projects/${projectId}/mixer`">
          <IconArrowLeft :size="17" /> Mixer
        </RouterLink>
      </template>
    </PageHeader>
    <ProjectStepper :current="4" />

    <div v-if="setupQuery.isPending.value" class="guide-loading">
      <div v-for="item in 4" :key="item" class="skeleton" />
    </div>
    <div v-else-if="setupQuery.isError.value" class="error-banner" role="alert">
      {{ setupQuery.error.value?.message ?? "Guide and click setup could not be loaded." }}
    </div>
    <template v-else>
      <div class="guide-layout">
        <main class="guide-workspace">
          <section class="surface guide-section" aria-labelledby="tracks-title">
            <div class="surface__header">
              <div>
                <h2 id="tracks-title">Tracks to create</h2>
                <p>Each output stays independent, so monitor mixes can use different levels.</p>
              </div>
            </div>
            <div class="guide-track-options">
              <label class="guide-track-option" :class="{ active: createGuide }">
                <input v-model="createGuide" type="checkbox" />
                <span class="guide-track-option__icon guide-track-option__icon--voice">
                  <IconMicrophone2 :size="21" />
                </span>
                <span>
                  <strong>Spoken guide</strong>
                  <small>Crisp woman voice for sections and count-ins</small>
                </span>
                <IconCheck v-if="createGuide" class="guide-track-option__check" :size="18" />
              </label>
              <label class="guide-track-option" :class="{ active: createClick }">
                <input v-model="createClick" type="checkbox" />
                <span class="guide-track-option__icon guide-track-option__icon--click">
                  <IconMetronome :size="21" />
                </span>
                <span>
                  <strong>Click track</strong>
                  <small>Downbeat accent plus regular beats</small>
                </span>
                <IconCheck v-if="createClick" class="guide-track-option__check" :size="18" />
              </label>
            </div>
          </section>

          <section class="surface guide-section" aria-labelledby="tempo-title">
            <div class="surface__header">
              <div>
                <h2 id="tempo-title">Tempo & measure</h2>
                <p>The click starts at 0:00 and remains constant for the full song.</p>
              </div>
              <span class="guide-duration"
                ><IconClock :size="16" /> {{ formatDuration(durationMs) }}</span
              >
            </div>
            <div class="guide-tempo-grid surface__body">
              <label class="field">
                <span>BPM</span>
                <input
                  v-model.number="bpm"
                  class="input guide-number-input"
                  type="number"
                  min="30"
                  max="300"
                  step="0.1"
                />
                <span class="field__hint">30–300 beats per minute</span>
              </label>
              <div class="field">
                <span>Time signature</span>
                <div class="time-signature-input">
                  <label>
                    <span class="visually-hidden">Beats per bar</span>
                    <select v-model.number="beatsPerBar" class="select">
                      <option v-for="count in 11" :key="count + 1" :value="count + 1">
                        {{ count + 1 }}
                      </option>
                    </select>
                  </label>
                  <span aria-hidden="true">/</span>
                  <label>
                    <span class="visually-hidden">Beat unit</span>
                    <select v-model.number="beatUnit" class="select">
                      <option :value="2">2</option>
                      <option :value="4">4</option>
                      <option :value="8">8</option>
                      <option :value="16">16</option>
                    </select>
                  </label>
                </div>
                <span class="field__hint">Accent on beat 1 of every bar</span>
              </div>
              <div class="guide-tempo-summary" aria-live="polite">
                <IconMetronome :size="25" />
                <span
                  ><strong>{{ bpm }} BPM · {{ beatsPerBar }}/{{ beatUnit }}</strong
                  ><small>About {{ estimatedBars }} bars across the song</small></span
                >
              </div>
            </div>
          </section>

          <section
            class="surface guide-section"
            :class="{ 'guide-section--disabled': !createGuide }"
            aria-labelledby="cues-title"
          >
            <div class="surface__header guide-cue-header">
              <div>
                <h2 id="cues-title">Spoken cues</h2>
                <p>Place each phrase on an exact musical bar and beat.</p>
              </div>
              <button
                class="button button--secondary button--small"
                type="button"
                @click="addCue()"
              >
                <IconPlus :size="16" /> Add cue
              </button>
            </div>
            <div class="guide-presets" aria-label="Common cue presets">
              <span>Quick add</span>
              <button
                v-for="preset in cuePresets"
                :key="preset"
                type="button"
                @click="addCue(preset)"
              >
                {{ preset }}
              </button>
            </div>
            <div class="cue-editor">
              <div class="cue-editor__labels" aria-hidden="true">
                <span>Bar</span><span>Beat</span><span>Spoken text</span><span>Position</span
                ><span></span>
              </div>
              <div v-for="(cue, index) in cues" :key="cue.id" class="cue-row">
                <label>
                  <span class="visually-hidden">Cue {{ index + 1 }} bar</span>
                  <input
                    v-model.number="cue.bar"
                    class="input"
                    type="number"
                    min="1"
                    :max="Math.max(1, estimatedBars)"
                  />
                </label>
                <label>
                  <span class="visually-hidden">Cue {{ index + 1 }} beat</span>
                  <select v-model.number="cue.beat" class="select">
                    <option v-for="beat in beatsPerBar" :key="beat" :value="beat">
                      {{ beat }}
                    </option>
                  </select>
                </label>
                <label>
                  <span class="visually-hidden">Cue {{ index + 1 }} spoken text</span>
                  <input
                    v-model="cue.text"
                    class="input"
                    type="text"
                    maxlength="160"
                    placeholder="e.g. Chorus"
                  />
                </label>
                <output :class="{ 'cue-time--invalid': cueTimeMs(cue) >= durationMs }">{{
                  formatDuration(cueTimeMs(cue))
                }}</output>
                <div class="cue-row__actions">
                  <button
                    class="icon-button"
                    type="button"
                    :disabled="previewingCueId === cue.id || !cue.text.trim()"
                    :aria-label="`Preview cue ${index + 1}`"
                    @click="previewCue(cue)"
                  >
                    <IconPlayerPlay :size="17" />
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :aria-label="`Delete cue ${index + 1}`"
                    @click="removeCue(cue.id)"
                  >
                    <IconTrash :size="17" />
                  </button>
                </div>
              </div>
              <div v-if="cues.length === 0" class="guide-cues-empty">
                <strong>No spoken cues yet</strong>
                <span>Add a custom cue or use one of the quick options above.</span>
              </div>
            </div>
          </section>
        </main>

        <aside class="surface guide-settings" aria-labelledby="settings-title">
          <div class="surface__header">
            <h2 id="settings-title">Voice & levels</h2>
            <IconHeadphones :size="19" />
          </div>
          <div class="guide-settings__body">
            <label class="field">
              <span>Guide voice</span>
              <select
                v-model="voiceName"
                class="select"
                :disabled="!createGuide || !setupQuery.data.value?.voices.length"
              >
                <option
                  v-for="voice in setupQuery.data.value?.voices"
                  :key="voice.name"
                  :value="voice.name"
                >
                  {{ voice.displayName ?? voice.name }} · {{ voice.provider ?? "system" }}
                </option>
              </select>
              <span class="field__hint">
                {{
                  selectedVoice?.description ??
                  "Neural guide voices are loaded through the local ML worker."
                }}
              </span>
            </label>
            <p v-if="previewError" class="error-banner" role="alert">{{ previewError }}</p>
            <label class="guide-range-field">
              <span
                >Speech speed <output>{{ speechRate > 0 ? "+" : "" }}{{ speechRate }}</output></span
              >
              <RangeSlider
                v-model="speechRate"
                :min="-5"
                :max="5"
                :step="1"
                :disabled="!createGuide"
                aria-label="Speech speed"
              />
            </label>
            <label class="guide-range-field">
              <span
                >Guide level <output>{{ guideVolumeDb.toFixed(1) }} dB</output></span
              >
              <RangeSlider
                v-model="guideVolumeDb"
                :min="-60"
                :max="6"
                :step="0.5"
                :disabled="!createGuide"
                aria-label="Guide track level"
                color="oklch(0.72 0.14 320)"
              />
            </label>
            <label class="guide-range-field">
              <span
                >Click level <output>{{ clickVolumeDb.toFixed(1) }} dB</output></span
              >
              <RangeSlider
                v-model="clickVolumeDb"
                :min="-60"
                :max="6"
                :step="0.5"
                :disabled="!createClick"
                aria-label="Click track level"
                color="oklch(0.76 0.14 86)"
              />
            </label>
            <div class="guide-generation-summary">
              <span
                ><strong>{{ orderedCues.length }}</strong> spoken cues</span
              >
              <span
                ><strong>{{ bpm }}</strong> BPM</span
              >
              <span
                ><strong>{{ beatsPerBar }}/{{ beatUnit }}</strong> measure</span
              >
            </div>
            <p v-if="validationError" class="error-banner" role="alert">{{ validationError }}</p>
            <p v-else-if="generateMutation.isError.value" class="error-banner" role="alert">
              {{ generateMutation.error.value?.message ?? "The tracks could not be generated." }}
            </p>
            <button
              class="button button--accent button--large guide-generate"
              type="button"
              :disabled="Boolean(validationError) || generateMutation.isPending.value"
              @click="generateMutation.mutate()"
            >
              <IconWand :size="18" />
              {{
                generateMutation.isPending.value ? "Generating audio…" : "Generate & add to mixer"
              }}
            </button>
            <span class="field__hint"
              >Existing guide or click tracks are replaced only for the outputs selected
              above.</span
            >
          </div>
        </aside>
      </div>

      <section
        v-if="resultTracks.length"
        class="surface guide-results"
        aria-labelledby="results-title"
      >
        <div class="surface__header">
          <div>
            <h2 id="results-title">Tracks in this project</h2>
            <p>
              {{
                generatedNow
                  ? "Generation complete. The new tracks are already in the mixer."
                  : "Previously generated tracks are already available in the mixer."
              }}
            </p>
          </div>
          <RouterLink class="button button--primary" :to="`/projects/${projectId}/mixer`"
            >Open mixer</RouterLink
          >
        </div>
        <div class="guide-result-list">
          <article v-for="track in resultTracks" :key="track.asset.id" class="guide-result">
            <div class="guide-result__identity">
              <span :class="`guide-result__icon guide-result__icon--${track.type}`"
                ><IconMicrophone2 v-if="track.type === 'guide'" :size="19" /><IconMetronome
                  v-else
                  :size="19"
              /></span>
              <span
                ><strong>{{ track.type === "guide" ? "Spoken guide" : "Click track" }}</strong
                ><small
                  >{{ track.settings.bpm }} BPM · {{ track.settings.beatsPerBar }}/{{
                    track.settings.beatUnit
                  }}
                  · {{ formatDuration(track.asset.durationMs) }}</small
                ></span
              >
            </div>
            <MiniAudioPlayer
              :src="track.asset.streamUrl"
              :label="track.type === 'guide' ? 'Spoken guide' : 'Click track'"
            />
          </article>
        </div>
      </section>
    </template>
  </div>
</template>
