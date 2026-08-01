<script setup lang="ts">
import { IconActivity, IconArrowRight, IconPlus, IconTrash } from "@tabler/icons-vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";

import type { ApiRecentJob } from "@audiotool/contracts";

import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusBadge from "../components/ui/StatusBadge.vue";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";

const queryClient = useQueryClient();
const projectsQuery = useQuery({
  queryKey: ["projects"],
  queryFn: api.listProjects,
  refetchInterval: 3_000,
});
const recentJobsQuery = useQuery({
  queryKey: ["recent-jobs"],
  queryFn: () => api.listRecentJobs(8),
  refetchInterval: 3_000,
});
const projects = computed(() => projectsQuery.data.value?.projects ?? []);
const recentJobs = computed(() => recentJobsQuery.data.value?.jobs ?? []);

const removeProject = useMutation({
  mutationFn: api.deleteProject,
  onSuccess: async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["recent-jobs"] }),
    ]);
  },
});

function nextRoute(projectId: string, status: string): string {
  if (status === "draft" || status === "analyzing") return `/projects/${projectId}/analyze`;
  if (status === "awaiting_confirmation") return `/projects/${projectId}/instruments`;
  if (status === "separating") return `/projects/${projectId}/separation`;
  return `/projects/${projectId}/mixer`;
}

function activeJobFor(projectId: string) {
  return recentJobs.value.find(
    (job) =>
      job.projectId === projectId &&
      ["queued", "detecting", "separating", "rendering"].includes(job.status),
  );
}

function projectRoute(projectId: string, status: string) {
  const route = nextRoute(projectId, status);
  const activeJob = activeJobFor(projectId);
  return activeJob ? `${route}?job=${activeJob.id}` : route;
}

function jobStage(job: ApiRecentJob) {
  return (job.currentStage ?? job.status).replaceAll("_", " ");
}

function confirmDelete(projectId: string, name: string) {
  if (window.confirm(`Delete “${name}”? This hides the project from the workspace.`)) {
    removeProject.mutate(projectId);
  }
}

function recentJobRoute(job: ApiRecentJob): string {
  const route = nextRoute(job.projectId, job.projectStatus);
  return job.status === "separating" || job.status === "rendering"
    ? `${route}?job=${job.id}`
    : route;
}
</script>

<template>
  <div>
    <PageHeader
      title="Projects"
      description="Your uploaded tracks, detections, stems, and saved mixes."
    >
      <template #actions>
        <RouterLink class="button button--primary" to="/projects/new">
          <IconPlus :size="18" /> New project
        </RouterLink>
      </template>
    </PageHeader>

    <div v-if="projectsQuery.isPending.value" class="project-list" aria-label="Loading projects">
      <div v-for="item in 4" :key="item" class="project-row project-row--skeleton">
        <div class="skeleton" />
        <div class="skeleton" />
      </div>
    </div>

    <div v-else-if="projectsQuery.isError.value" class="error-banner" role="alert">
      {{ projectsQuery.error.value?.message ?? "Projects could not be loaded." }}
      <button
        class="button button--secondary button--small"
        type="button"
        @click="projectsQuery.refetch()"
      >
        Try again
      </button>
    </div>

    <EmptyState
      v-else-if="projects.length === 0"
      title="Your first session starts with one song"
      description="Upload a track, inspect the detected instruments, and decide which stems should be generated."
    >
      <RouterLink class="button button--primary" to="/projects/new">Create a project</RouterLink>
    </EmptyState>

    <div v-else class="project-list">
      <article v-for="project in projects" :key="project.id" class="project-row">
        <RouterLink class="project-row__main" :to="projectRoute(project.id, project.status)">
          <span class="project-row__art" aria-hidden="true">
            <i
              v-for="height in [18, 28, 12, 34, 22, 30, 15]"
              :key="height"
              :style="{ height: `${height}px` }"
            />
          </span>
          <span class="project-row__copy">
            <strong>{{ project.name }}</strong>
            <template v-if="activeJobFor(project.id)">
              <small class="project-row__active-copy">
                {{ jobStage(activeJobFor(project.id)!) }} ·
                {{ activeJobFor(project.id)!.progress }}% · continues in background
              </small>
              <span
                class="project-row__inline-progress"
                role="progressbar"
                :aria-label="`${project.name} ${activeJobFor(project.id)!.progress}% complete`"
                :aria-valuenow="activeJobFor(project.id)!.progress"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <i :style="{ width: `${activeJobFor(project.id)!.progress}%` }" />
              </span>
            </template>
            <small v-else>Updated {{ formatDate(project.updatedAt) }}</small>
          </span>
        </RouterLink>
        <StatusBadge :status="project.status" />
        <button
          class="icon-button"
          type="button"
          :aria-label="`Delete ${project.name}`"
          :disabled="removeProject.isPending.value"
          @click="confirmDelete(project.id, project.name)"
        >
          <IconTrash :size="18" />
        </button>
        <RouterLink
          class="icon-button"
          :to="projectRoute(project.id, project.status)"
          :aria-label="`Open ${project.name}`"
        >
          <IconArrowRight :size="19" />
        </RouterLink>
      </article>
    </div>

    <section class="recent-jobs" aria-labelledby="recent-jobs-title">
      <header class="section-heading">
        <span class="section-heading__icon" aria-hidden="true"><IconActivity :size="19" /></span>
        <span>
          <h2 id="recent-jobs-title">Recent jobs</h2>
          <p>Latest detection, separation, and render activity.</p>
        </span>
      </header>

      <div v-if="recentJobsQuery.isPending.value" class="recent-job-list" aria-label="Loading jobs">
        <div v-for="item in 3" :key="item" class="recent-job-row recent-job-row--skeleton">
          <span class="skeleton" />
          <span class="skeleton" />
        </div>
      </div>
      <div v-else-if="recentJobsQuery.isError.value" class="error-banner" role="alert">
        {{ recentJobsQuery.error.value?.message ?? "Recent jobs could not be loaded." }}
        <button
          class="button button--secondary button--small"
          type="button"
          @click="recentJobsQuery.refetch()"
        >
          Try again
        </button>
      </div>
      <div v-else-if="recentJobs.length === 0" class="recent-jobs__empty">
        No processing jobs yet. Analyze a project to see its progress here.
      </div>
      <div v-else class="recent-job-list">
        <RouterLink
          v-for="job in recentJobs"
          :key="job.id"
          class="recent-job-row"
          :to="recentJobRoute(job)"
          :aria-label="`Open ${job.projectName} ${job.status} job`"
        >
          <span class="recent-job-row__copy">
            <strong>{{ job.projectName }}</strong>
            <small>
              {{ job.mode }} · {{ (job.currentStage ?? job.status).replaceAll("_", " ") }} ·
              {{ formatDate(job.queuedAt) }}
            </small>
          </span>
          <span class="recent-job-row__progress" :aria-label="`${job.progress}% complete`">
            <i :style="{ width: `${job.progress}%` }" />
          </span>
          <StatusBadge :status="job.status" />
          <IconArrowRight :size="18" aria-hidden="true" />
        </RouterLink>
      </div>
    </section>
  </div>
</template>
