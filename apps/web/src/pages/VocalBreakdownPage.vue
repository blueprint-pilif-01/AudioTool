<script setup lang="ts">
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChartDots,
  IconHeadphones,
  IconMusic,
  IconPlayerPlay,
  IconSparkles,
  IconWaveSine,
} from "@tabler/icons-vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type {
  VocalBreakdownPart,
  VocalNoteEvent,
  VocalRegisterSummary,
} from "@audiotool/contracts";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";

import MiniAudioPlayer from "../components/audio/MiniAudioPlayer.vue";
import PageHeader from "../components/ui/PageHeader.vue";
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
const breakdownQuery = useQuery({
  queryKey: computed(() => ["vocal-breakdown", projectId.value]),
  queryFn: () => api.getVocalBreakdown(projectId.value),
});

const selectedParts = ref<VocalBreakdownPart[]>(["melody", "soprano", "alto", "tenor", "bass"]);
const generatedNow = ref(false);
const partOptions: Array<{
  part: VocalBreakdownPart;
  name: string;
  description: string;
  range: string;
}> = [
  {
    part: "melody",
    name: "Melody guide",
    description: "A clean synthesized tone following the dominant vocal pitch.",
    range: "Detected lead",
  },
  {
    part: "soprano",
    name: "Soprano focus",
    description: "Moments where the dominant pitch is in the highest learning lane.",
    range: "F♯4–C6",
  },
  {
    part: "alto",
    name: "Alto focus",
    description: "Mid-high vocal phrases to isolate and rehearse.",
    range: "A♯3–F4",
  },
  {
    part: "tenor",
    name: "Tenor focus",
    description: "Mid-low phrases selected from the vocal stem.",
    range: "C3–A3",
  },
  {
    part: "bass",
    name: "Bass focus",
    description: "The lowest detected vocal phrases.",
    range: "C2–B2",
  },
];

const analysis = computed(
  () => generateMutation.data.value?.analysis ?? breakdownQuery.data.value?.analysis ?? null,
);
const tracks = computed(
  () => generateMutation.data.value?.tracks ?? breakdownQuery.data.value?.tracks ?? [],
);
const noteBounds = computed(() => {
  const notes = analysis.value?.notes ?? [];
  if (!notes.length) return { minimum: 48, maximum: 72 };
  return {
    minimum: Math.max(24, Math.min(...notes.map((note) => note.midi)) - 2),
    maximum: Math.min(96, Math.max(...notes.map((note) => note.midi)) + 2),
  };
});
const pianoNotes = computed(() => (analysis.value?.notes ?? []).slice(0, 500));

function noteStyle(note: VocalNoteEvent) {
  const duration = Math.max(1, analysis.value?.durationMs ?? 1);
  const range = Math.max(1, noteBounds.value.maximum - noteBounds.value.minimum + 1);
  return {
    left: `${(note.startMs / duration) * 100}%`,
    width: `${Math.max(0.18, ((note.endMs - note.startMs) / duration) * 100)}%`,
    top: `${((noteBounds.value.maximum - note.midi) / range) * 100}%`,
    "--note-confidence": String(Math.max(0.25, note.confidence)),
  };
}

function summaryFor(part: VocalBreakdownPart): VocalRegisterSummary | undefined {
  if (part === "melody") return undefined;
  return analysis.value?.registers.find((summary) => summary.part === part);
}

function percentage(value: number | undefined) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

const generateMutation = useMutation({
  mutationFn: () => api.generateVocalBreakdown(projectId.value, { parts: selectedParts.value }),
  onSuccess: async () => {
    generatedNow.value = true;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["vocal-breakdown", projectId.value] }),
      queryClient.invalidateQueries({ queryKey: ["mix", projectId.value] }),
    ]);
  },
});
</script>

<template>
  <div class="vocal-breakdown-page">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Vocal breakdown'"
      description="Turn the separated vocal stem into a melody guide and pitch-register focus tracks for learning and rehearsal."
    >
      <template #actions>
        <RouterLink class="button button--secondary" :to="`/projects/${projectId}/mixer`">
          <IconArrowLeft :size="17" /> Mixer
        </RouterLink>
      </template>
    </PageHeader>
    <ProjectStepper :current="4" />

    <div v-if="breakdownQuery.isPending.value" class="vocal-breakdown-loading">
      <div v-for="item in 3" :key="item" class="skeleton" />
    </div>
    <div v-else-if="breakdownQuery.isError.value" class="error-banner" role="alert">
      {{ breakdownQuery.error.value?.message ?? "Vocal Breakdown could not be loaded." }}
    </div>
    <template v-else>
      <section class="vocal-source surface" aria-labelledby="vocal-source-title">
        <div class="vocal-source__identity">
          <span><IconWaveSine :size="21" /></span>
          <div>
            <strong id="vocal-source-title">Source: Vocals stem</strong>
            <small>
              {{ formatDuration(breakdownQuery.data.value?.durationMs ?? 0) }} · already isolated by
              the stem splitter
            </small>
          </div>
        </div>
        <MiniAudioPlayer
          v-if="breakdownQuery.data.value?.vocalStem"
          :src="breakdownQuery.data.value.vocalStem.streamUrl"
          label="Vocals stem"
        />
      </section>

      <div class="vocal-breakdown-layout">
        <main class="vocal-breakdown-main">
          <section class="surface vocal-part-picker" aria-labelledby="parts-title">
            <div class="surface__header">
              <div>
                <h2 id="parts-title">Learning tracks</h2>
                <p>Select the tracks you want to generate from the vocal stem.</p>
              </div>
            </div>
            <div class="vocal-part-list">
              <label
                v-for="option in partOptions"
                :key="option.part"
                class="vocal-part-option"
                :class="[
                  `vocal-part-option--${option.part}`,
                  { active: selectedParts.includes(option.part) },
                ]"
              >
                <input v-model="selectedParts" type="checkbox" :value="option.part" />
                <span class="vocal-part-option__marker"><IconMusic :size="18" /></span>
                <span class="vocal-part-option__copy">
                  <strong>{{ option.name }}</strong>
                  <small>{{ option.description }}</small>
                </span>
                <span class="vocal-part-option__range">{{ option.range }}</span>
              </label>
            </div>
          </section>

          <section v-if="analysis" class="surface vocal-analysis" aria-labelledby="pitch-map-title">
            <div class="surface__header">
              <div>
                <h2 id="pitch-map-title">Detected melody</h2>
                <p>Each block is a stable dominant note found in the separated vocal stem.</p>
              </div>
              <span class="status-badge status-badge--info"
                ><IconChartDots :size="14" /> {{ pianoNotes.length }} phrases</span
              >
            </div>
            <div class="vocal-analysis-stats">
              <span
                ><small>Lowest</small><strong>{{ analysis.lowestNote ?? "—" }}</strong></span
              >
              <span
                ><small>Median</small><strong>{{ analysis.medianNote ?? "—" }}</strong></span
              >
              <span
                ><small>Highest</small><strong>{{ analysis.highestNote ?? "—" }}</strong></span
              >
              <span
                ><small>Voiced time</small
                ><strong>{{ formatDuration(analysis.voicedDurationMs) }}</strong></span
              >
              <span
                ><small>Confidence</small
                ><strong>{{ percentage(analysis.confidence) }}</strong></span
              >
            </div>
            <div class="vocal-piano-roll" role="img" aria-label="Timeline of detected vocal notes">
              <span class="vocal-piano-roll__high">{{ analysis.highestNote ?? "High" }}</span>
              <span class="vocal-piano-roll__low">{{ analysis.lowestNote ?? "Low" }}</span>
              <i
                v-for="(note, index) in pianoNotes"
                :key="`${note.startMs}-${index}`"
                :class="`vocal-note vocal-note--${note.register}`"
                :style="noteStyle(note)"
                :title="`${note.note} · ${formatDuration(note.startMs)} · ${percentage(note.confidence)}`"
              />
              <div v-if="pianoNotes.length === 0" class="vocal-piano-roll__empty">
                No stable melody notes were detected in this stem.
              </div>
            </div>
            <div class="vocal-register-legend" aria-label="Vocal register colors">
              <span
                v-for="part in ['bass', 'tenor', 'alto', 'soprano']"
                :key="part"
                :class="`vocal-register-legend__${part}`"
                >{{ part }}</span
              >
            </div>
          </section>

          <section
            v-if="tracks.length"
            class="surface vocal-track-results"
            aria-labelledby="vocal-results-title"
          >
            <div class="surface__header">
              <div>
                <h2 id="vocal-results-title">Practice tracks</h2>
                <p>
                  {{
                    generatedNow
                      ? "New tracks are ready and were added to the mixer."
                      : "These tracks are already available in the mixer."
                  }}
                </p>
              </div>
              <RouterLink class="button button--primary" :to="`/projects/${projectId}/mixer`"
                >Open mixer</RouterLink
              >
            </div>
            <div class="vocal-track-list">
              <article
                v-for="track in tracks"
                :key="track.asset.id"
                :class="`vocal-track vocal-track--${track.part}`"
              >
                <div class="vocal-track__identity">
                  <span><IconPlayerPlay :size="18" /></span>
                  <div>
                    <strong>{{ track.displayName }}</strong>
                    <small v-if="track.part === 'melody'"
                      >Synthesized dominant melody ·
                      {{ percentage(track.confidence) }} confidence</small
                    >
                    <small v-else
                      >{{ percentage(track.coverage) }} of voiced phrases ·
                      {{ percentage(track.confidence) }} confidence</small
                    >
                  </div>
                </div>
                <MiniAudioPlayer :src="track.asset.streamUrl" :label="track.displayName" />
              </article>
            </div>
          </section>
        </main>

        <aside class="vocal-breakdown-aside">
          <section class="surface vocal-generate-card">
            <div class="surface__header">
              <h2>Analyze & create</h2>
              <IconHeadphones :size="19" />
            </div>
            <div class="vocal-generate-card__body">
              <div class="vocal-selection-count">
                <strong>{{ selectedParts.length }}</strong
                ><span>tracks selected</span>
              </div>
              <button
                class="button button--accent button--large"
                type="button"
                :disabled="selectedParts.length === 0 || generateMutation.isPending.value"
                @click="generateMutation.mutate()"
              >
                <IconSparkles :size="18" />
                {{
                  generateMutation.isPending.value
                    ? "Analyzing vocals…"
                    : analysis
                      ? "Regenerate selected"
                      : "Analyze vocal stem"
                }}
              </button>
              <p v-if="generateMutation.isError.value" class="error-banner" role="alert">
                {{ generateMutation.error.value?.message ?? "Vocal analysis failed." }}
              </p>
              <span class="field__hint"
                >Pitch analysis runs locally. Longer songs can take a little while.</span
              >
            </div>
          </section>

          <section class="notice vocal-honesty-note">
            <IconAlertTriangle :size="20" />
            <div>
              <strong>Experimental register focus</strong>
              <p>
                This follows the dominant pitch and gates the existing vocal stem by range. It
                cannot identify or cleanly separate simultaneous singers as individual people.
              </p>
            </div>
          </section>

          <section
            v-if="analysis"
            class="surface vocal-register-summary"
            aria-labelledby="register-summary-title"
          >
            <div class="surface__header">
              <h2 id="register-summary-title">Register coverage</h2>
            </div>
            <div class="vocal-register-summary__list">
              <div
                v-for="option in partOptions.filter((item) => item.part !== 'melody')"
                :key="option.part"
              >
                <span
                  ><strong>{{ option.name.replace(" focus", "") }}</strong
                  ><small>{{ summaryFor(option.part)?.range ?? option.range }}</small
                  ><output>{{ percentage(summaryFor(option.part)?.coverage) }}</output></span
                >
                <i
                  ><b
                    :class="`vocal-coverage--${option.part}`"
                    :style="{ width: percentage(summaryFor(option.part)?.coverage) }"
                /></i>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>
