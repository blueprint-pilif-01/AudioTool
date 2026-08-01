<script setup lang="ts">
import { IconArrowLeft, IconWaveSine } from "@tabler/icons-vue";
</script>

<template>
  <section class="not-found">
    <IconWaveSine :size="36" />
    <h1>This route is silent.</h1>
    <p>The page you requested does not exist or was moved into another audio workflow.</p>
    <RouterLink class="button button--primary" to="/"
      ><IconArrowLeft :size="18" /> Back to AudioTool</RouterLink
    >
  </section>
</template>
