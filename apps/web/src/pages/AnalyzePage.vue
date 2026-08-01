<script setup lang="ts">
import {
  IconArrowRight,
  IconClock,
  IconFileMusic,
  IconPlayerPlay,
  IconRefresh,
} from "@tabler/icons-vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { ApiJob } from "@audiotool/contracts";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import WaveformCanvas from "../components/audio/WaveformCanvas.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import JobProgress from "../components/workflow/JobProgress.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api, subscribeToJob } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const projectId = computed(() => String(route.params.id));
const projectQuery = useQuery({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () => api.getProject(projectId.value),
});
const sourceId = computed(() => projectQuery.data.value?.project.sourceAudioId ?? "");
const audioQuery = useQuery({
  queryKey: computed(() => ["audio", sourceId.value]),
  queryFn: () => api.getAudio(sourceId.value),
  enabled: computed(() => Boolean(sourceId.value)),
});
const capabilitiesQuery = useQuery({
  queryKey: ["ml-capabilities"],
  queryFn: api.getMlCapabilities,
});
const jobsQuery = useQuery({
  queryKey: computed(() => ["jobs", projectId.value]),
  queryFn: () => api.listJobs(projectId.value),
  refetchInterval: 3_000,
});

const providerDescription = computed(() => {
  if (capabilitiesQuery.isPending.value) {
    return "Checking the configured audio model before detection.";
  }
  const capabilities = capabilitiesQuery.data.value?.capabilities;
  if (!capabilities) {
    return "The configured audio model will be checked when analysis starts.";
  }
  if (capabilities.mock) {
    return "Development mock active: it returns deterministic test labels and does not analyze the recording.";
  }
  return `Detection will use ${capabilities.modelName} (${capabilities.modelVersion}) on the configured ML worker.`;
});

const running = ref(false);
const jobId = ref("");
const progress = ref(0);
const stage = ref("queued");
const message = ref("");
const error = ref("");
const job = ref<ApiJob | null>(null);
let unsubscribe: (() => void) | null = null;
let connectedJobId = "";

const restoringJob = computed(
  () => projectQuery.data.value?.project.status === "analyzing" && jobsQuery.isPending.value,
);
const failedJob = computed(() =>
  job.value?.status === "failed" || job.value?.status === "cancelled" ? job.value : null,
);

function isActive(status: ApiJob["status"]) {
  return ["queued", "detecting"].includes(status);
}

function connect(id: string) {
  if (connectedJobId === id && unsubscribe) return;
  unsubscribe?.();
  connectedJobId = id;
  unsubscribe = subscribeToJob(
    id,
    (event) => {
      progress.value = event.progress;
      stage.value = event.stage;
      message.value = event.message;
      if (event.status === "awaiting_confirmation") {
        running.value = false;
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["project", projectId.value] }),
          queryClient.invalidateQueries({ queryKey: ["jobs", projectId.value] }),
        ]);
      }
      if (event.status === "failed" || event.status === "cancelled") {
        running.value = false;
        error.value = event.message;
        void queryClient.invalidateQueries({ queryKey: ["jobs", projectId.value] });
      }
    },
    () => {
      if (running.value) message.value = "Live updates disconnected. The job may still be running.";
    },
  );
}

async function startDetection() {
  if (running.value) return;
  running.value = true;
  error.value = "";
  progress.value = 0;
  try {
    const result = await api.startDetection(projectId.value);
    job.value = result.job;
    jobId.value = result.job.id;
    stage.value = result.job.currentStage ?? result.job.status;
    connect(result.job.id);
  } catch (cause) {
    running.value = false;
    error.value = cause instanceof Error ? cause.message : "Instrument detection could not start.";
  }
}

watch(
  [() => projectQuery.data.value?.project.status, () => jobsQuery.data.value?.jobs],
  ([status, jobs]) => {
    if (!status) return;
    const latest = jobs?.[0];
    if (status === "separating") {
      const suffix = latest ? `?job=${latest.id}` : "";
      void router.replace(`/projects/${projectId.value}/separation${suffix}`);
      return;
    }
    if (status === "ready") {
      void router.replace(`/projects/${projectId.value}/mixer`);
      return;
    }
    if (status === "awaiting_confirmation") {
      running.value = false;
      return;
    }
    if (status !== "analyzing" || !latest) return;
    job.value = { ...latest };
    progress.value = latest.progress;
    stage.value = latest.currentStage ?? latest.status;
    if (isActive(latest.status)) {
      running.value = true;
      error.value = "";
      message.value = "Restored this analysis job. Processing continues on the backend.";
      connect(latest.id);
    } else if (latest.status === "failed" || latest.status === "cancelled") {
      running.value = false;
      error.value = latest.errorMessage ?? `The previous analysis was ${latest.status}.`;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <div class="workflow-page workflow-page--narrow">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Analyze track'"
      description="Read the source and detect the instrument categories that are likely to be present."
    />
    <ProjectStepper :current="1" />

    <div
      v-if="projectQuery.isPending.value || audioQuery.isPending.value"
      class="surface source-skeleton"
    >
      <div class="skeleton" />
      <div class="skeleton" />
      <div class="skeleton" />
    </div>

    <div
      v-else-if="projectQuery.isError.value || audioQuery.isError.value"
      class="error-banner"
      role="alert"
    >
      {{
        projectQuery.error.value?.message ??
        audioQuery.error.value?.message ??
        "Source audio could not be loaded."
      }}
    </div>

    <template v-else-if="audioQuery.data.value?.asset">
      <section class="source-panel surface">
        <div class="source-panel__meta">
          <span class="source-panel__icon"><IconFileMusic :size="24" /></span>
          <div>
            <strong>{{ audioQuery.data.value.asset.originalFilename }}</strong>
            <span>
              {{ formatDuration(audioQuery.data.value.asset.durationMs) }} /
              {{ formatBytes(audioQuery.data.value.asset.sizeBytes) }} /
              {{
                audioQuery.data.value.asset.sampleRate
                  ? `${audioQuery.data.value.asset.sampleRate / 1000} kHz`
                  : "Sample rate unknown"
              }}
            </span>
          </div>
          <audio :src="audioQuery.data.value.asset.streamUrl" controls preload="metadata" />
        </div>
        <WaveformCanvas :url="audioQuery.data.value.asset.streamUrl" :height="88" />
      </section>

      <JobProgress
        v-if="running || restoringJob"
        :progress="progress"
        :stage="stage"
        :message="
          restoringJob
            ? 'Restoring the active analysis job from PostgreSQL…'
            : message || 'Analysis is running on the backend. You can safely leave this page.'
        "
        :stages="['Preparing', 'Detecting', 'Awaiting confirmation']"
      />

      <div v-if="running || restoringJob" class="analysis-resume-note" role="status">
        <IconClock :size="18" />
        <div>
          <strong>Your position is saved</strong>
          <span>
            You can open Projects or close this page. Returning to this project restores this exact
            job and its latest progress.
          </span>
        </div>
      </div>

      <section v-else class="analysis-action surface">
        <div>
          <span class="analysis-action__icon"><IconPlayerPlay :size="24" /></span>
          <div>
            <h2>
              {{
                projectQuery.data.value?.project.status === "awaiting_confirmation"
                  ? "Detection complete"
                  : failedJob
                    ? "Analysis needs attention"
                    : "Ready to inspect this track"
              }}
            </h2>
            <p>
              {{
                projectQuery.data.value?.project.status === "awaiting_confirmation"
                  ? "Review confidence, correct the list, and choose the stems you want."
                  : failedJob
                    ? "The previous job stopped. Its error is shown below and retrying creates one safe replacement job."
                    : providerDescription
              }}
            </p>
          </div>
        </div>
        <RouterLink
          v-if="projectQuery.data.value?.project.status === 'awaiting_confirmation'"
          class="button button--primary"
          :to="`/projects/${projectId}/instruments`"
        >
          Review instruments <IconArrowRight :size="18" />
        </RouterLink>
        <button
          v-else
          class="button button--primary"
          type="button"
          :disabled="jobsQuery.isPending.value"
          @click="startDetection"
        >
          <IconRefresh v-if="failedJob" :size="18" />
          {{ failedJob ? "Retry analysis" : "Analyze instruments" }}
          <IconArrowRight v-if="!failedJob" :size="18" />
        </button>
      </section>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    </template>
  </div>
</template>
