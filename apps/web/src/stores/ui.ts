import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ThemePreference = "light" | "dark" | "system";

const storageKey = "audiotool-theme";

function readPreference(): ThemePreference {
  const saved = localStorage.getItem(storageKey);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<ThemePreference>(readPreference());
  const mobileNavigationOpen = ref(false);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const darkMediaMatches = ref(systemDark.matches);

  systemDark.addEventListener("change", (event) => {
    darkMediaMatches.value = event.matches;
  });

  const resolvedTheme = computed(() =>
    theme.value === "system" ? (darkMediaMatches.value ? "dark" : "light") : theme.value,
  );

  function applyTheme() {
    document.documentElement.dataset.theme = resolvedTheme.value;
    document.documentElement.style.colorScheme = resolvedTheme.value;
  }

  function cycleTheme() {
    theme.value = resolvedTheme.value === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, theme.value);
    applyTheme();
  }

  applyTheme();

  return { theme, resolvedTheme, mobileNavigationOpen, cycleTheme, applyTheme };
});
