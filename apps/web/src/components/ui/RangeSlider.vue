<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    ariaLabel?: string;
    ariaValueText?: string;
    color?: string;
    disabled?: boolean;
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    color: "var(--primary)",
    disabled: false,
  },
);

const model = defineModel<number>({ required: true });

const progress = computed(() => {
  const span = props.max - props.min;
  if (span <= 0) return 0;
  const value = Math.max(props.min, Math.min(props.max, Number(model.value)));
  return ((value - props.min) / span) * 100;
});

const sliderStyle = computed<Record<string, string>>(() => ({
  "--range-progress": `${progress.value}%`,
  "--range-color": props.color,
}));

function update(event: Event) {
  model.value = Number((event.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    class="range-slider"
    type="range"
    :value="model"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :aria-valuetext="ariaValueText"
    :style="sliderStyle"
    @input="update"
  />
</template>
