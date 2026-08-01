<script setup lang="ts">
import { IconDownload, IconPlayerPlay, IconRefresh } from "@tabler/icons-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import ToolHeader from "../../components/tools/ToolHeader.vue";
import RangeSlider from "../../components/ui/RangeSlider.vue";
import FileDropzone from "../../components/workflow/FileDropzone.vue";
import { api, downloadBlob } from "../../lib/api";
import { useToolHandoffStore, type KeyBpmHandoff } from "../../stores/tools";

const route = useRoute();
const handoff = useToolHandoffStore();
const file = ref<File | null>(handoff.file);
const analysis = ref<KeyBpmHandoff | null>(handoff.analysis);
const pitch = ref(0);
const tempo = ref(100);
const processing = ref(false);
const analyzing = ref(false);
const error = ref("");
const result = ref<Blob | null>(null);
const resultUrl = ref("");
let analyzedIdentity = handoff.file
  ? `${handoff.file.name}:${handoff.file.size}:${handoff.file.lastModified}`
  : "";

const pitchLabel = computed(() => `${pitch.value > 0 ? "+" : ""}${pitch.value} st`);
const queryBpm = computed(() => {
  const parsed = Number(route.query.bpm);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
});
const sourceBpm = computed(() => analysis.value?.bpm ?? queryBpm.value);
const sourceKey = computed(() => analysis.value?.key ?? String(route.query.key ?? "Not analyzed"));
const sourceScale = computed(() => analysis.value?.scale ?? String(route.query.scale ?? ""));
const outputBpm = computed(() =>
  sourceBpm.value ? Math.round(sourceBpm.value * (tempo.value / 100) * 10) / 10 : null,
);

const keyIndexes: Record<string, number> = {
  C: 0,
  "C♯": 1,
  "D♭": 1,
  D: 2,
  "D♯": 3,
  "E♭": 3,
  E: 4,
  F: 5,
  "F♯": 6,
  "G♭": 6,
  G: 7,
  "G♯": 8,
  "A♭": 8,
  A: 9,
  "A♯": 10,
  "B♭": 10,
  B: 11,
};
const outputKeys = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const outputKey = computed(() => {
  const sourceIndex = keyIndexes[sourceKey.value];
  if (sourceIndex === undefined) return "Not analyzed";
  const index = (sourceIndex + pitch.value + outputKeys.length * 2) % outputKeys.length;
  return `${outputKeys[index]} ${sourceScale.value}`.trim();
});

function clearResult() {
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
  resultUrl.value = "";
  result.value = null;
}

function reset() {
  pitch.value = 0;
  tempo.value = 100;
  clearResult();
}

async function analyzeSource(next: File | null) {
  clearResult();
  if (!next) {
    analysis.value = null;
    analyzedIdentity = "";
    return;
  }
  const identity = `${next.name}:${next.size}:${next.lastModified}`;
  if (identity === analyzedIdentity && analysis.value) return;
  analyzing.value = true;
  error.value = "";
  try {
    analysis.value = (await api.analyzeKeyBpm(next)).analysis;
    analyzedIdentity = identity;
  } catch (cause) {
    analysis.value = null;
    error.value = cause instanceof Error ? cause.message : "Source analysis failed.";
  } finally {
    analyzing.value = false;
  }
}

async function process() {
  if (!file.value || processing.value) return;
  processing.value = true;
  error.value = "";
  clearResult();
  try {
    result.value = await api.processPitchTempo(file.value, pitch.value, tempo.value);
    resultUrl.value = URL.createObjectURL(result.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Audio processing failed.";
  } finally {
    processing.value = false;
  }
}

function download() {
  if (!result.value || !file.value) return;
  downloadBlob(result.value, `${file.value.name.replace(/\.[^.]+$/, "")}-pitch-tempo.wav`);
}

watch(file, (next) => void analyzeSource(next), { immediate: true });
watch([pitch, tempo], clearResult);
onBeforeUnmount(clearResult);
</script>

<template>
  <div class="tool-page">
    <ToolHeader
      title="Pitch & tempo"
      description="Analyze the source, adjust pitch and tempo independently, preview the rendered result, then export WAV."
    />
    <div class="tool-workspace">
      <section class="tool-workspace__main">
        <FileDropzone v-model="file" :disabled="processing || analyzing" />

        <div class="source-analysis" aria-live="polite">
          <div>
            <span>Original key</span>
            <strong>{{ analyzing ? "Analyzing" : `${sourceKey} ${sourceScale}`.trim() }}</strong>
          </div>
          <div>
            <span>Original tempo</span>
            <strong>{{ sourceBpm ? `${sourceBpm.toFixed(1)} BPM` : "Not analyzed" }}</strong>
          </div>
          <div>
            <span>Result key</span>
            <strong>{{ outputKey }}</strong>
          </div>
          <div>
            <span>Result tempo</span>
            <strong>{{ outputBpm ? `${outputBpm.toFixed(1)} BPM` : "Not analyzed" }}</strong>
          </div>
        </div>

        <div class="parameter-stack">
          <label class="parameter-row">
            <span><strong>Pitch</strong><small>Semitones</small></span>
            <RangeSlider
              v-model="pitch"
              :min="-12"
              :max="12"
              :step="1"
              aria-label="Pitch in semitones"
              :aria-value-text="pitchLabel"
            />
            <output>{{ pitchLabel }}</output>
          </label>
          <label class="parameter-row">
            <span><strong>Tempo</strong><small>Original is 100%</small></span>
            <RangeSlider
              v-model="tempo"
              :min="50"
              :max="200"
              :step="1"
              aria-label="Tempo percentage"
              :aria-value-text="`${tempo}%`"
            />
            <output>{{ tempo }}%</output>
          </label>
        </div>

        <div v-if="resultUrl" class="tool-preview" aria-live="polite">
          <div>
            <strong>Rendered preview</strong
            ><span>Pitch and tempo are processed independently.</span>
          </div>
          <audio :src="resultUrl" controls preload="metadata" />
        </div>

        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <div class="tool-actions">
          <button class="button button--secondary" type="button" @click="reset">
            <IconRefresh :size="17" /> Reset
          </button>
          <button
            class="button button--accent"
            type="button"
            :disabled="!file || processing || analyzing"
            @click="process"
          >
            <IconPlayerPlay :size="17" /> {{ processing ? "Processing" : "Render preview" }}
          </button>
          <button v-if="result" class="button button--primary" type="button" @click="download">
            <IconDownload :size="17" /> Download WAV
          </button>
        </div>
      </section>
      <aside class="tool-workspace__aside tool-workspace__aside--data">
        <span>Output</span><strong>WAV</strong> <span>Pitch range</span><strong>±12 st</strong>
        <span>Tempo range</span><strong>50-200%</strong>
      </aside>
    </div>
  </div>
</template>
