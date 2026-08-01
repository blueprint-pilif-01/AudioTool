<script setup lang="ts">
import {
  IconAdjustmentsHorizontal,
  IconArrowsJoin,
  IconBrandSpeedtest,
  IconCut,
  IconFolder,
  IconMenu2,
  IconMicrophone2,
  IconMoon,
  IconSun,
  IconWaveSine,
  IconX,
} from "@tabler/icons-vue";
import { onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";

import { useUiStore } from "../../stores/ui";
import AppLogo from "../brand/AppLogo.vue";

const route = useRoute();
const ui = useUiStore();

watch(
  () => route.fullPath,
  () => {
    ui.mobileNavigationOpen = false;
  },
);

watch(
  () => ui.mobileNavigationOpen,
  (open) => document.body.classList.toggle("navigation-open", open),
);

onBeforeUnmount(() => document.body.classList.remove("navigation-open"));

const primaryLinks = [{ to: "/projects", label: "Projects", icon: IconFolder }];
const toolLinks = [
  { to: "/tools/vocal-remover", label: "Vocal remover", icon: IconMicrophone2 },
  { to: "/tools/splitter", label: "Stem splitter", icon: IconWaveSine },
  { to: "/tools/pitch-tempo", label: "Pitch & tempo", icon: IconAdjustmentsHorizontal },
  { to: "/tools/key-bpm", label: "Key & BPM", icon: IconBrandSpeedtest },
  { to: "/tools/cutter", label: "Audio cutter", icon: IconCut },
  { to: "/tools/joiner", label: "Audio joiner", icon: IconArrowsJoin },
];
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="mobile-topbar">
      <button
        class="icon-button"
        type="button"
        aria-label="Open navigation"
        @click="ui.mobileNavigationOpen = true"
      >
        <IconMenu2 :size="21" />
      </button>
      <AppLogo />
      <button
        class="icon-button"
        type="button"
        :aria-label="`Switch to ${ui.resolvedTheme === 'dark' ? 'light' : 'dark'} theme`"
        @click="ui.cycleTheme"
      >
        <IconSun v-if="ui.resolvedTheme === 'dark'" :size="19" />
        <IconMoon v-else :size="19" />
      </button>
    </header>

    <button
      v-if="ui.mobileNavigationOpen"
      class="navigation-scrim"
      type="button"
      aria-label="Close navigation"
      @click="ui.mobileNavigationOpen = false"
    />

    <aside class="sidebar" :class="{ 'sidebar--open': ui.mobileNavigationOpen }">
      <div class="sidebar__brand">
        <AppLogo />
        <button
          class="icon-button sidebar__close"
          type="button"
          aria-label="Close navigation"
          @click="ui.mobileNavigationOpen = false"
        >
          <IconX :size="20" />
        </button>
      </div>

      <nav class="sidebar__navigation" aria-label="Workspace navigation">
        <RouterLink v-for="item in primaryLinks" :key="item.to" :to="item.to" class="sidebar-link">
          <component :is="item.icon" :size="19" stroke-width="1.8" />
          <span>{{ item.label }}</span>
        </RouterLink>

        <p class="sidebar__group-label">Audio tools</p>
        <RouterLink v-for="item in toolLinks" :key="item.to" :to="item.to" class="sidebar-link">
          <component :is="item.icon" :size="19" stroke-width="1.8" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar__footer">
        <div class="engine-status">
          <span class="engine-status__dot" />
          <span>
            <strong>Local processing</strong>
            <small>Files stay on this machine</small>
          </span>
        </div>
        <button class="theme-toggle" type="button" @click="ui.cycleTheme">
          <IconSun v-if="ui.resolvedTheme === 'dark'" :size="18" />
          <IconMoon v-else :size="18" />
          {{ ui.resolvedTheme === "dark" ? "Light theme" : "Dark theme" }}
        </button>
      </div>
    </aside>

    <main id="main-content" class="app-content" :class="{ 'app-content--wide': route.meta.wide }">
      <slot />
      <footer class="app-credit">
        <a
          href="https://blueprint-studio-works.ro"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Created with love by Blueprint Studio Works (opens in a new tab)"
        >
          Created with <span aria-hidden="true">♥</span> by
          <strong>Blueprint Studio Works</strong>
        </a>
      </footer>
    </main>
  </div>
</template>
