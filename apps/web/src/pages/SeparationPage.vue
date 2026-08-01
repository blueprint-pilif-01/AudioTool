<script setup lang="ts">
import {
  IconArrowRight,
  IconMetronome,
  IconMusic,
  IconPlayerStop,
  IconRefresh,
} from "@tabler/icons-vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { ApiJob, JobEventPayload } from "@audiotool/contracts";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import PageHeader from "../components/ui/PageHeader.vue";
import JobProgress from "../components/workflow/JobProgress.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api, subscribeToJob } from "../lib/api";

const route = useRoute();
const queryClient = useQueryClient();
const projectId = computed(() => String(route.params.id));
const requestedJobId = computed(() => (typeof route.query.job === "string" ? route.query.job : ""));
const projectQuery = useQuery({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () => api.getProject(projectId.value),
});
const jobsQuery = useQuery({
  queryKey: computed(() => ["jobs", projectId.value]),
  queryFn: () => api.listJobs(projectId.value),
});
const requestedJobQuery = useQuery({
  queryKey: computed(() => ["job", requestedJobId.value]),
  queryFn: () => api.getJob(requestedJobId.value),
  enabled: computed(() => Boolean(requestedJobId.value)),
});
const stemsQuery = useQuery({
  queryKey: computed(() => ["stems", projectId.value]),
  queryFn: () => api.getStems(projectId.value),
  enabled: computed(() => projectQuery.data.value?.project.status === "ready"),
});
const job = ref<ApiJob | null>(null);
const message = ref("");
const disconnected = ref(false);
let unsubscribe: (() => void) | null = null;
const selectedJob = computed(
  () =>
    requestedJobQuery.data.value?.job ??
    jobsQuery.data.value?.jobs.find((item) => item.id === requestedJobId.value) ??
    jobsQuery.data.value?.jobs[0],
);
const isJobPending = computed(
  () =>
    jobsQuery.isPending.value ||
    (Boolean(requestedJobId.value) && requestedJobQuery.isPending.value),
);
const jobError = computed(
  () => requestedJobQuery.error.value?.message ?? jobsQuery.error.value?.message,
);

function applyEvent(event: JobEventPayload) {
  if (!job.value) return;
  job.value = {
    ...job.value,
    status: event.status,
    progress: event.progress,
    currentStage: event.stage,
  };
  message.value = event.message;
  if (["completed", "failed", "cancelled"].includes(event.status)) {
    unsubscribe?.();
    unsubscribe = null;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["project", projectId.value] }),
      queryClient.invalidateQueries({ queryKey: ["stems", projectId.value] }),
    ]);
  }
}

function connect(jobId: string) {
  unsubscribe?.();
  disconnected.value = false;
  unsubscribe = subscribeToJob(jobId, applyEvent, () => (disconnected.value = true));
}

watch(
  selectedJob,
  (selected) => {
    if (!selected) return;
    job.value = { ...selected };
    message.value =
      selected.status === "completed"
        ? "Stem separation is complete."
        : "Processing audio locally.";
    if (!["completed", "failed", "cancelled"].includes(selected.status)) connect(selected.id);
  },
  { immediate: true },
);

async function cancel() {
  if (!job.value) return;
  await api.cancelJob(job.value.id);
}

async function retry() {
  if (!job.value) return;
  const result = await api.retryJob(job.value.id);
  job.value = result.job;
  connect(result.job.id);
}

onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <div class="workflow-page workflow-page--narrow">
    <PageHeader
      :title="projectQuery.data.value?.project.name ?? 'Separate stems'"
      description="Each selected category is processed into its own stem. Unassigned material becomes Other / residual."
    />
    <ProjectStepper :current="3" />

    <div v-if="isJobPending" class="surface source-skeleton">
      <div class="skeleton" />
      <div class="skeleton" />
      <div class="skeleton" />
    </div>
    <div v-else-if="jobError || !job" class="error-banner" role="alert">
      {{ jobError ?? "No separation job was found for this project." }}
    </div>
    <template v-else>
      <JobProgress
        :progress="job.progress"
        :stage="job.currentStage ?? job.status"
        :message="
          disconnected ? 'Live updates disconnected. Refresh to check the final state.' : message
        "
        :stages="['Preparing', 'Separating stems', 'Creating mixer', 'Completed']"
      />

      <div v-if="job.status === 'completed'" class="separation-complete">
        <div>
          <strong>{{ stemsQuery.data.value?.stems.length ?? 0 }} stems ready</strong>
          <span>The mix session was created and saved to PostgreSQL.</span>
        </div>
        <div class="separation-complete__actions">
          <RouterLink
            class="button button--secondary"
            :to="`/projects/${projectId}/vocal-breakdown`"
          >
            <IconMusic :size="18" /> Vocal breakdown
          </RouterLink>
          <RouterLink class="button button--secondary" :to="`/projects/${projectId}/guide-click`">
            <IconMetronome :size="18" /> Guide & click
          </RouterLink>
          <RouterLink class="button button--accent" :to="`/projects/${projectId}/mixer`">
            Open mixer <IconArrowRight :size="18" />
          </RouterLink>
        </div>
      </div>
      <div
        v-else-if="job.status === 'failed' || job.status === 'cancelled'"
        class="workflow-actions"
      >
        <p class="error-banner">{{ job.errorMessage ?? `The job was ${job.status}.` }}</p>
        <button class="button button--secondary" type="button" @click="retry">
          <IconRefresh :size="18" /> Retry job
        </button>
      </div>
      <div v-else class="workflow-actions">
        <span class="field__hint">You can leave this page. The job continues on the backend.</span>
        <button class="button button--secondary" type="button" @click="cancel">
          <IconPlayerStop :size="18" /> Cancel
        </button>
      </div>
    </template>
  </div>
</template>
