<script setup lang="ts">
import { IconMoon, IconSun } from "@tabler/icons-vue";

import { useUiStore } from "../../stores/ui";
import AppLogo from "../brand/AppLogo.vue";

const ui = useUiStore();
</script>

<template>
  <header class="public-header">
    <a class="skip-link" href="#main-content">Skip to content</a>
    <div class="public-header__inner">
      <AppLogo />
      <nav aria-label="Main navigation">
        <RouterLink to="/projects">Projects</RouterLink>
        <RouterLink to="/tools/splitter">Tools</RouterLink>
        <button
          class="icon-button"
          type="button"
          :aria-label="`Switch to ${ui.resolvedTheme === 'dark' ? 'light' : 'dark'} theme`"
          @click="ui.cycleTheme"
        >
          <IconSun v-if="ui.resolvedTheme === 'dark'" :size="19" />
          <IconMoon v-else :size="19" />
        </button>
        <RouterLink class="button button--primary button--small" to="/projects/new">
          New project
        </RouterLink>
      </nav>
    </div>
  </header>
</template>
