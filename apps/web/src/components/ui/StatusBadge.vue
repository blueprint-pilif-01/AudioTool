<script setup lang="ts">
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconLoader2,
  IconPlayerPause,
} from "@tabler/icons-vue";
import { computed } from "vue";

const props = defineProps<{ status: string }>();

const labels: Record<string, string> = {
  draft: "Draft",
  analyzing: "Analyzing",
  awaiting_confirmation: "Needs confirmation",
  separating: "Separating",
  ready: "Ready",
  failed: "Failed",
  queued: "Queued",
  detecting: "Detecting",
  rendering: "Rendering",
  completed: "Completed",
  cancelled: "Cancelled",
};

const tone = computed(() => {
  if (props.status === "failed") return "danger";
  if (props.status === "ready" || props.status === "completed") return "success";
  if (props.status === "cancelled") return "muted";
  if (props.status === "awaiting_confirmation") return "warning";
  return "info";
});

const icon = computed(() => {
  if (tone.value === "danger") return IconAlertTriangle;
  if (tone.value === "success") return IconCheck;
  if (tone.value === "warning") return IconClock;
  if (tone.value === "muted") return IconPlayerPause;
  return IconLoader2;
});
</script>

<template>
  <span class="status-badge" :class="`status-badge--${tone}`">
    <component :is="icon" :size="14" :class="{ spinning: tone === 'info' }" />
    {{ labels[status] ?? status.replaceAll("_", " ") }}
  </span>
</template>
