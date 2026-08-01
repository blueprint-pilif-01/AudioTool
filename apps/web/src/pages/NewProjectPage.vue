<script setup lang="ts">
import { IconArrowRight, IconInfoCircle } from "@tabler/icons-vue";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import PageHeader from "../components/ui/PageHeader.vue";
import FileDropzone from "../components/workflow/FileDropzone.vue";
import ProjectStepper from "../components/workflow/ProjectStepper.vue";
import { api } from "../lib/api";

const router = useRouter();
const name = ref("");
const file = ref<File | null>(null);
const progress = ref(0);
const saving = ref(false);
const error = ref("");

const defaultName = computed(() => file.value?.name.replace(/\.[^.]+$/, "") ?? "");

async function createProject() {
  if (!file.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const { project } = await api.createProject(
      name.value.trim() || defaultName.value || "Untitled session",
    );
    await api.uploadAudio(project.id, file.value, (value) => (progress.value = value));
    await router.push(`/projects/${project.id}/analyze`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The project could not be created.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="workflow-page workflow-page--narrow">
    <PageHeader
      title="New audio project"
      description="Upload the original recording. Instrument detection runs only after the file is stored and validated."
    />
    <ProjectStepper :current="0" />

    <form class="surface project-form" @submit.prevent="createProject">
      <div class="surface__header"><h2>Source audio</h2></div>
      <div class="surface__body project-form__body">
        <label class="field">
          <span>Project name</span>
          <input
            v-model.trim="name"
            class="input"
            type="text"
            maxlength="120"
            :placeholder="defaultName || 'For example: Rehearsal take 03'"
            :disabled="saving"
          />
          <small class="field__hint">You can rename the project later.</small>
        </label>

        <FileDropzone v-model="file" :disabled="saving" />

        <div class="notice">
          <IconInfoCircle :size="19" />
          <div>
            <strong>Private by default</strong><br />
            Audio is processed by your configured local backend. It is never sent to Groq
            automatically.
          </div>
        </div>

        <div v-if="saving" class="upload-status" aria-live="polite">
          <div>
            <span>Uploading and reading metadata</span><strong>{{ progress }}%</strong>
          </div>
          <div class="upload-progress"><span :style="{ width: `${progress}%` }" /></div>
        </div>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      </div>
      <footer class="project-form__footer">
        <RouterLink class="button button--secondary" to="/projects">Cancel</RouterLink>
        <button class="button button--primary" type="submit" :disabled="!file || saving">
          {{ saving ? "Creating project" : "Continue to analysis" }}
          <IconArrowRight v-if="!saving" :size="18" />
        </button>
      </footer>
    </form>
  </div>
</template>
