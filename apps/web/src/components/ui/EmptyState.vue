<script setup lang="ts">
import { IconMusicPlus } from "@tabler/icons-vue";

defineProps<{ title: string; description: string }>();
</script>

<template>
  <div class="empty-state">
    <div class="empty-state__icon"><IconMusicPlus :size="26" stroke-width="1.7" /></div>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
