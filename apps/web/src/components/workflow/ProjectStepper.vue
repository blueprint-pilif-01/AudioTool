<script setup lang="ts">
import { IconCheck } from "@tabler/icons-vue";
import { computed } from "vue";

const props = defineProps<{ current: number }>();
const steps = ["Upload", "Analyze", "Instruments", "Separate", "Mix"];
const completion = computed(() => `${Math.max(0, Math.min(100, (props.current / 4) * 100))}%`);
</script>

<template>
  <nav class="project-stepper" aria-label="Project progress">
    <div class="project-stepper__track" aria-hidden="true">
      <span :style="{ width: completion }" />
    </div>
    <ol>
      <li
        v-for="(step, index) in steps"
        :key="step"
        :class="{ active: index === current, complete: index < current }"
        :aria-current="index === current ? 'step' : undefined"
      >
        <span class="project-stepper__marker">
          <IconCheck v-if="index < current" :size="14" />
          <span v-else>{{ index + 1 }}</span>
        </span>
        <span>{{ step }}</span>
      </li>
    </ol>
  </nav>
</template>
