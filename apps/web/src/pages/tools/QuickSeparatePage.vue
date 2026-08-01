<script setup lang="ts">
import { IconArrowRight, IconInfoCircle } from "@tabler/icons-vue";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import ToolHeader from "../../components/tools/ToolHeader.vue";
import FileDropzone from "../../components/workflow/FileDropzone.vue";
import { api } from "../../lib/api";

const props = defineProps<{ mode: "vocal-remover" | "splitter" }>();
const router = useRouter();
const file = ref<File | null>(null);
const progress = ref(0);
const processing = ref(false);
const error = ref("");
const isVocal = computed(() => props.mode === "vocal-remover");

async function start() {
  if (!file.value || processing.value) return;
  processing.value = true;
  error.value = "";
  try {
    const cleanName = file.value.name.replace(/\.[^.]+$/, "");
    const { project } = await api.createProject(
      `${cleanName} ${isVocal.value ? "vocal split" : "stems"}`,
    );
    await api.uploadAudio(project.id, file.value, (value) => (progress.value = value));
    if (isVocal.value) {
      const { job } = await api.startSeparation(project.id, "quick");
      await router.push({ path: `/projects/${project.id}/separation`, query: { job: job.id } });
    } else {
      await router.push(`/projects/${project.id}/analyze`);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The audio job could not be started.";
  } finally {
    processing.value = false;
  }
}
</script>

<template>
  <div class="tool-page">
    <ToolHeader
      :title="isVocal ? 'Vocal remover' : 'Instrument splitter'"
      :description="
        isVocal
          ? 'Create vocal and instrumental stems with the quick two-stem workflow.'
          : 'Detect the instruments in a song first, then choose a separate stem for every category you need.'
      "
    />
    <div class="tool-workspace">
      <section class="tool-workspace__main">
        <FileDropzone v-model="file" :disabled="processing" />
        <div v-if="processing" class="upload-status" aria-live="polite">
          <div>
            <span>Uploading source audio</span><strong>{{ progress }}%</strong>
          </div>
          <div class="upload-progress"><span :style="{ width: `${progress}%` }" /></div>
        </div>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <button
          class="button button--accent button--large"
          type="button"
          :disabled="!file || processing"
          @click="start"
        >
          {{
            processing ? "Preparing project" : isVocal ? "Separate vocals" : "Detect instruments"
          }}
          <IconArrowRight v-if="!processing" :size="18" />
        </button>
      </section>
      <aside class="tool-workspace__aside">
        <IconInfoCircle :size="20" />
        <div>
          <h2>{{ isVocal ? "Two focused outputs" : "Not limited to four stems" }}</h2>
          <p>
            {{
              isVocal
                ? "Quick mode intentionally generates Vocals and Instrumental. Use Instrument splitter when you want individual categories."
                : "You review the detected list before separation. Other / residual is generated automatically for unassigned audio."
            }}
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
