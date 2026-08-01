<script setup lang="ts">
defineProps<{ compact?: boolean }>();
</script>

<template>
  <RouterLink class="app-logo" to="/" aria-label="AudioTool home">
    <span class="logo-mark" aria-hidden="true">
      <i v-for="height in [7, 13, 20, 11, 16]" :key="height" :style="{ height: `${height}px` }" />
    </span>
    <span v-if="!compact" class="logo-type">Audio<span>Tool</span></span>
  </RouterLink>
</template>
