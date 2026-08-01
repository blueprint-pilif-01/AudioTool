<script setup lang="ts">
import { IconArrowRight, IconCheck, IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-vue";
import { useQuery } from "@tanstack/vue-query";
import type { InstrumentDetection, InstrumentLabel } from "@audiotool/contracts";
import { instrumentDisplayNames, instrumentLabels } from "@audiotool/contracts";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import PageHeader from "../components/ui/PageHeader.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api } from "../lib/api";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.id));
const projectQuery = useQuery({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () => api.getProject(projectId.value),
});
const detectionsQuery = useQuery({
  queryKey: computed(() => ["detections", projectId.value]),
  queryFn: () => api.getDetections(projectId.value),
});
const capabilitiesQuery = useQuery({
  queryKey: ["ml-capabilities"],
  queryFn: api.getMlCapabilities,
});
const detections = ref<InstrumentDetection[]>([]);
const addLabel = ref<InstrumentLabel>("piano");
const saving = ref(false);
const error = ref("");
const textureLabels = ["synthesizer", "percussion"] as const;

function isTextureSplitDetection(detection: InstrumentDetection): boolean {
  return (
    detection.modelName === "residual-texture-split" &&
    textureLabels.includes(detection.canonicalLabel as (typeof textureLabels)[number])
  );
}

watch(
  () => detectionsQuery.data.value?.detections,
  (value) => {
    if (value)
      detections.value = value.map((item) => ({ ...item, detectedSpans: [...item.detectedSpans] }));
  },
  { immediate: true },
);

const selectedCount = computed(() => detections.value.filter((item) => item.selected).length);
const usesTextureSplit = computed(() =>
  detections.value.some((item) => item.selected && isTextureSplitDetection(item)),
);
const selectedTextureCount = computed(
  () => detections.value.filter((item) => item.selected && isTextureSplitDetection(item)).length,
);
const expectedStemCount = computed(
  () => selectedCount.value + (usesTextureSplit.value ? 2 - selectedTextureCount.value : 1),
);
const hasTextureDetections = computed(() => detections.value.some(isTextureSplitDetection));
const capabilities = computed(() => capabilitiesQuery.data.value?.capabilities);
const modelSummary = computed(() => {
  const current = capabilities.value;
  if (current) return `${current.modelName} · ${current.modelVersion}`;
  const detected = detections.value.find((item) => !item.manuallyAdded);
  return detected ? `${detected.modelName} · ${detected.modelVersion}` : "Provider unavailable";
});
const supportedLabelSet = computed(() => new Set(capabilities.value?.supportedLabels ?? []));
function isSupported(label: InstrumentLabel): boolean {
  return !capabilities.value || supportedLabelSet.value.has(label);
}
const unsupportedSelected = computed(() =>
  detections.value.filter((item) => item.selected && !isSupported(item.canonicalLabel)),
);
const availableLabels = computed(() =>
  instrumentLabels.filter(
    (label) => label !== "other" && !detections.value.some((item) => item.canonicalLabel === label),
  ),
);

function addInstrument() {
  if (!availableLabels.value.includes(addLabel.value)) return;
  const supported = isSupported(addLabel.value);
  detections.value.push({
    canonicalLabel: addLabel.value,
    displayLabel: instrumentDisplayNames[addLabel.value],
    confidence: 1,
    detectedSpans: [],
    selected: supported,
    manuallyAdded: true,
    modelName: "manual",
    modelVersion: "user",
  });
  addLabel.value = availableLabels.value[0] ?? "piano";
}

function syncTexturePair(detection: InstrumentDetection): void {
  if (!isTextureSplitDetection(detection)) return;
  const counterpart = detections.value.find(
    (item) => item.canonicalLabel !== detection.canonicalLabel && isTextureSplitDetection(item),
  );
  if (counterpart) counterpart.selected = detection.selected;
}

async function continueToSeparation() {
  if (selectedCount.value === 0 || unsupportedSelected.value.length > 0 || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await api.saveDetections(projectId.value, detections.value);
    const selectedIds = saved.detections
      .filter((item) => item.selected && item.id)
      .map((item) => item.id as string);
    const { job } = await api.startSeparation(projectId.value, "auto", selectedIds);
    await router.push({ path: `/projects/${projectId.value}/separation`, query: { job: job.id } });
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "The instrument selection could not be saved.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="workflow-page">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Confirm instruments'"
      description="Choose the controls you need. Residual material is added unless its complementary texture pair is selected."
    />
    <ProjectStepper :current="2" />

    <div v-if="detectionsQuery.isPending.value" class="instrument-list surface">
      <div v-for="item in 5" :key="item" class="instrument-row instrument-row--skeleton">
        <span class="skeleton" /><span class="skeleton" /><span class="skeleton" />
      </div>
    </div>

    <div v-else-if="detectionsQuery.isError.value" class="error-banner" role="alert">
      {{ detectionsQuery.error.value?.message ?? "Detections could not be loaded." }}
    </div>

    <template v-else>
      <section class="instrument-editor surface">
        <header class="surface__header">
          <div>
            <h2>Detected categories</h2>
            <p>{{ selectedCount }} of {{ detections.length }} selected</p>
          </div>
          <span class="instrument-editor__model">{{ modelSummary }}</span>
        </header>
        <div v-if="capabilities && !capabilities.mock" class="provider-capability-note">
          <strong>Real provider active</strong>
          <span>
            {{ capabilities.modelName }} can render
            {{
              capabilities.supportedLabels
                .filter((label) => label !== "other")
                .map((label) => instrumentDisplayNames[label])
                .join(", ")
            }}. Other manual labels can be kept for a future provider, but cannot be selected now.
          </span>
        </div>
        <div class="instrument-list">
          <article
            v-for="(detection, index) in detections"
            :key="detection.id ?? `${detection.canonicalLabel}-${index}`"
            class="instrument-row"
          >
            <label class="instrument-check">
              <input
                v-model="detection.selected"
                type="checkbox"
                :disabled="!isSupported(detection.canonicalLabel) && !detection.selected"
                @change="syncTexturePair(detection)"
              />
              <span><IconCheck :size="14" /></span>
              <span class="visually-hidden">Include {{ detection.displayLabel }}</span>
            </label>
            <div class="instrument-row__identity">
              <input
                v-model.trim="detection.displayLabel"
                class="instrument-name"
                type="text"
                maxlength="100"
                :aria-label="`Display name for ${detection.canonicalLabel}`"
              />
              <div class="instrument-meta">
                <span>{{ detection.canonicalLabel.replaceAll("_", " ") }}</span>
                <span v-if="!isSupported(detection.canonicalLabel)" class="capability-warning">
                  Not supported by {{ capabilities?.modelName ?? "this provider" }}
                </span>
              </div>
            </div>
            <div
              class="confidence"
              :aria-label="`${Math.round(detection.confidence * 100)} percent confidence`"
            >
              <span><i :style="{ width: `${Math.round(detection.confidence * 100)}%` }" /></span>
              <strong>{{
                detection.manuallyAdded ? "Manual" : `${Math.round(detection.confidence * 100)}%`
              }}</strong>
            </div>
            <button
              class="icon-button"
              type="button"
              :aria-label="`Remove ${detection.displayLabel}`"
              @click="detections.splice(index, 1)"
            >
              <IconTrash :size="18" />
            </button>
          </article>
        </div>
        <div v-if="hasTextureDetections" class="texture-split-note">
          <strong>Synth &amp; loop texture controls</strong>
          <span>
            These two linked tracks divide Other into sustained synth/pad texture and transient
            loops/percussion/FX. Together they replace Other; they are texture estimates, not exact
            instrument identities.
          </span>
        </div>

        <div class="instrument-add">
          <div class="select-wrap">
            <select v-model="addLabel" class="select" :disabled="availableLabels.length === 0">
              <option v-for="label in availableLabels" :key="label" :value="label">
                {{ instrumentDisplayNames[label] }}
              </option>
            </select>
            <IconChevronDown :size="17" aria-hidden="true" />
          </div>
          <button
            class="button button--secondary"
            type="button"
            :disabled="availableLabels.length === 0"
            @click="addInstrument"
          >
            <IconPlus :size="18" /> Add instrument
          </button>
        </div>
      </section>

      <p v-if="selectedCount === 0" class="error-banner" role="alert">
        Select at least one instrument category before continuing.
      </p>
      <p v-else-if="unsupportedSelected.length > 0" class="error-banner" role="alert">
        Uncheck the unsupported instrument categories before starting this provider.
      </p>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>

      <div class="workflow-actions">
        <RouterLink class="button button--secondary" :to="`/projects/${projectId}/analyze`"
          >Back</RouterLink
        >
        <button
          class="button button--primary"
          type="button"
          :disabled="selectedCount === 0 || unsupportedSelected.length > 0 || saving"
          @click="continueToSeparation"
        >
          {{ saving ? "Starting separation" : `Separate ${expectedStemCount} stems` }}
          <IconArrowRight v-if="!saving" :size="18" />
        </button>
      </div>
    </template>
  </div>
</template>
