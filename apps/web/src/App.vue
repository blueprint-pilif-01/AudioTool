<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";

import AppShell from "./components/layout/AppShell.vue";
import PublicHeader from "./components/layout/PublicHeader.vue";

const route = useRoute();
const isPublic = computed(() => Boolean(route.meta.public));
</script>

<template>
  <div v-if="isPublic" class="public-layout">
    <PublicHeader />
    <main id="main-content">
      <RouterView v-slot="{ Component }">
        <Transition name="route" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
  </div>
  <AppShell v-else>
    <RouterView v-slot="{ Component }">
      <Transition name="route" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
  </AppShell>
</template>
