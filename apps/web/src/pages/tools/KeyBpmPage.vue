<script setup lang="ts">
import {
  IconArrowRight,
  IconDownload,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-vue";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import ToolHeader from "../../components/tools/ToolHeader.vue";
import FileDropzone from "../../components/workflow/FileDropzone.vue";
import { api, downloadBlob } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import { useToolHandoffStore } from "../../stores/tools";

type Analysis = Awaited<ReturnType<typeof api.analyzeKeyBpm>>["analysis"];
interface AnalysisRow {
  file: File;
  analysis: Analysis | null;
  error: string;
}

const router = useRouter();
const handoff = useToolHandoffStore();
const files = ref<File[]>([]);
const rows = ref<AnalysisRow[]>([]);
const processing = ref(false);
const error = ref("");
const completedRows = computed(() => rows.value.filter((row) => row.analysis));

function addFiles(incoming: File[]) {
  const existing = new Set(
    files.value.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
  );
  for (const file of incoming) {
    const identity = `${file.name}:${file.size}:${file.lastModified}`;
    if (!existing.has(identity)) {
      files.value.push(file);
      existing.add(identity);
    }
  }
}

function removeFile(index: number) {
  files.value.splice(index, 1);
  rows.value = [];
}

async function analyze() {
  if (files.value.length === 0 || processing.value) return;
  processing.value = true;
  error.value = "";
  rows.value = files.value.map((file) => ({ file, analysis: null, error: "" }));
  for (const row of rows.value) {
    try {
      row.analysis = (await api.analyzeKeyBpm(row.file)).analysis;
    } catch (cause) {
      row.error = cause instanceof Error ? cause.message : "Key and BPM analysis failed.";
    }
  }
  processing.value = false;
  if (completedRows.value.length === 0)
    error.value = "None of the selected files could be analyzed.";
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportResults(format: "csv" | "json") {
  const records = completedRows.value.map(({ file, analysis }) => ({
    filename: file.name,
    key: analysis!.key,
    scale: analysis!.scale,
    bpm: analysis!.bpm,
    confidence: analysis!.confidence,
    durationMs: analysis!.durationMs,
    analyzedDurationMs: analysis!.analyzedDurationMs,
    elapsedMs: analysis!.elapsedMs,
    tempoCandidates: analysis!.tempoCandidates,
    provider: analysis!.provider,
  }));
  if (format === "json") {
    downloadBlob(
      new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }),
      "audiotool-key-bpm.json",
    );
    return;
  }
  const header = [
    "filename",
    "key",
    "scale",
    "bpm",
    "confidence",
    "duration_ms",
    "analyzed_duration_ms",
    "elapsed_ms",
    "tempo_candidates",
    "provider",
  ];
  const lines = records.map((record) =>
    [
      record.filename,
      record.key,
      record.scale,
      record.bpm,
      record.confidence,
      record.durationMs,
      record.analyzedDurationMs,
      record.elapsedMs,
      record.tempoCandidates.join("|"),
      record.provider,
    ]
      .map(csvCell)
      .join(","),
  );
  downloadBlob(
    new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" }),
    "audiotool-key-bpm.csv",
  );
}

async function openPitchTempo(row: AnalysisRow) {
  if (!row.analysis) return;
  handoff.setKeyBpm(row.file, row.analysis);
  await router.push({
    path: "/tools/pitch-tempo",
    query: {
      key: row.analysis.key,
      scale: row.analysis.scale,
      bpm: String(row.analysis.bpm),
    },
  });
}
</script>

<template>
  <div class="tool-page">
    <ToolHeader
      title="Key & BPM finder"
      description="Analyze one file or a batch locally, compare tempo alternatives, and export structured results."
    />
    <section class="tool-editor surface">
      <FileDropzone multiple :disabled="processing" @files="addFiles" />

      <ol v-if="files.length" class="analysis-file-list" aria-label="Files queued for analysis">
        <li v-for="(item, index) in files" :key="`${item.name}-${item.lastModified}`">
          <span>{{ index + 1 }}</span>
          <strong>{{ item.name }}</strong>
          <button
            class="icon-button"
            type="button"
            :disabled="processing"
            :aria-label="`Remove ${item.name}`"
            @click="removeFile(index)"
          >
            <IconTrash :size="17" />
          </button>
        </li>
      </ol>

      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <div class="tool-actions">
        <button
          class="button button--accent"
          type="button"
          :disabled="files.length === 0 || processing"
          @click="analyze"
        >
          <IconRefresh v-if="processing" :size="18" class="spinning" />
          <IconPlayerPlay v-else :size="18" />
          {{ processing ? "Analyzing batch" : `Analyze ${files.length || "files"}` }}
        </button>
        <button
          class="button button--secondary"
          type="button"
          :disabled="completedRows.length === 0"
          @click="exportResults('csv')"
        >
          <IconDownload :size="17" /> CSV
        </button>
        <button
          class="button button--secondary"
          type="button"
          :disabled="completedRows.length === 0"
          @click="exportResults('json')"
        >
          <IconDownload :size="17" /> JSON
        </button>
      </div>
    </section>

    <section v-if="rows.length" class="analysis-results" aria-label="Key and BPM results">
      <article
        v-for="row in rows"
        :key="`${row.file.name}-${row.file.lastModified}`"
        class="analysis-result-row"
      >
        <div class="analysis-result-row__file">
          <strong>{{ row.file.name }}</strong>
          <span v-if="row.analysis">
            {{ formatDuration(row.analysis.analyzedDurationMs) }} analyzed in
            {{ (row.analysis.elapsedMs / 1000).toFixed(2) }}s
          </span>
          <span v-else-if="row.error" class="error-text">{{ row.error }}</span>
          <span v-else>Waiting for analysis</span>
        </div>
        <template v-if="row.analysis">
          <div>
            <span>Key</span><strong>{{ row.analysis.key }} {{ row.analysis.scale }}</strong>
          </div>
          <div>
            <span>Tempo</span><strong>{{ row.analysis.bpm.toFixed(1) }} BPM</strong>
          </div>
          <div>
            <span>Confidence</span><strong>{{ Math.round(row.analysis.confidence * 100) }}%</strong>
          </div>
          <div>
            <span>Tempo candidates</span>
            <strong>{{
              row.analysis.tempoCandidates.map((value) => `${value} BPM`).join(" / ")
            }}</strong>
          </div>
          <button
            class="button button--secondary button--small"
            type="button"
            @click="openPitchTempo(row)"
          >
            Open in Pitch & Tempo <IconArrowRight :size="16" />
          </button>
        </template>
      </article>
    </section>
  </div>
</template>
