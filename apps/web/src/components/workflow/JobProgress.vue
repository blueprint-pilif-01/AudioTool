<script setup lang="ts">
import { IconCheck, IconLoader2 } from "@tabler/icons-vue";
import { computed } from "vue";

const props = defineProps<{
  progress: number;
  stage: string;
  message?: string;
  stages: string[];
}>();

const activeIndex = computed(() => {
  const exact = props.stages.findIndex(
    (stage) => stage.toLowerCase() === props.stage.toLowerCase(),
  );
  if (exact >= 0) return exact;
  return Math.min(
    props.stages.length - 1,
    Math.floor((props.progress / 100) * props.stages.length),
  );
});
</script>

<template>
  <section class="job-progress" aria-live="polite" aria-atomic="true">
    <div class="job-progress__summary">
      <div>
        <span>{{ stage.replaceAll("_", " ") }}</span>
        <strong>{{ Math.round(progress) }}%</strong>
      </div>
      <div
        class="job-progress__bar"
        role="progressbar"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span :style="{ width: `${progress}%` }" />
      </div>
      <p v-if="message">{{ message }}</p>
    </div>

    <ol class="job-progress__stages">
      <li
        v-for="(item, index) in stages"
        :key="item"
        :class="{ active: index === activeIndex, complete: index < activeIndex }"
      >
        <span>
          <IconCheck v-if="index < activeIndex" :size="14" />
          <IconLoader2 v-else-if="index === activeIndex" :size="15" class="spinning" />
          <i v-else />
        </span>
        {{ item }}
      </li>
    </ol>
  </section>
</template>
