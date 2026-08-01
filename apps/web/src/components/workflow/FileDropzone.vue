<script setup lang="ts">
import { IconFileMusic, IconUpload, IconX } from "@tabler/icons-vue";
import { computed, ref } from "vue";

import { formatBytes } from "../../lib/format";

const props = withDefaults(
  defineProps<{
    modelValue?: File | null;
    multiple?: boolean;
    accept?: string;
    disabled?: boolean;
  }>(),
  { modelValue: null, multiple: false, accept: "audio/*", disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: File | null];
  files: [value: File[]];
}>();

const dragging = ref(false);
const input = ref<HTMLInputElement | null>(null);
const selectedName = computed(() => props.modelValue?.name ?? null);

function receive(files: FileList | File[]) {
  const accepted = Array.from(files).filter((file) => file.type.startsWith("audio/") || !file.type);
  if (accepted.length === 0) return;
  emit("files", props.multiple ? accepted : [accepted[0] as File]);
  if (!props.multiple) emit("update:modelValue", accepted[0] as File);
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (props.disabled || !event.dataTransfer) return;
  receive(event.dataTransfer.files);
}
</script>

<template>
  <div
    class="dropzone"
    :class="{ 'dropzone--dragging': dragging, 'dropzone--selected': selectedName }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <input
      ref="input"
      class="visually-hidden"
      type="file"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      @change="
        ($event.target as HTMLInputElement).files &&
        receive(($event.target as HTMLInputElement).files!)
      "
    />

    <template v-if="modelValue && !multiple">
      <div class="dropzone__file-icon"><IconFileMusic :size="27" /></div>
      <div class="dropzone__copy">
        <strong>{{ modelValue.name }}</strong>
        <span>{{ formatBytes(modelValue.size) }} · Ready to upload</span>
      </div>
      <button
        class="icon-button"
        type="button"
        aria-label="Remove selected file"
        @click.stop="emit('update:modelValue', null)"
      >
        <IconX :size="19" />
      </button>
    </template>
    <template v-else>
      <div class="dropzone__file-icon"><IconUpload :size="27" /></div>
      <div class="dropzone__copy">
        <strong>{{ multiple ? "Drop audio files here" : "Drop a song here" }}</strong>
        <span>MP3, WAV, FLAC, M4A, AAC, OGG or WebM</span>
      </div>
      <button class="button button--secondary" type="button" @click="input?.click()">
        Browse files
      </button>
    </template>
  </div>
</template>
