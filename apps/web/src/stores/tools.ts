import { defineStore } from "pinia";
import { ref } from "vue";

export interface KeyBpmHandoff {
  key: string;
  scale: "major" | "minor";
  bpm: number;
  confidence: number;
}

export const useToolHandoffStore = defineStore("tool-handoff", () => {
  const file = ref<File | null>(null);
  const analysis = ref<KeyBpmHandoff | null>(null);

  function setKeyBpm(nextFile: File, nextAnalysis: KeyBpmHandoff) {
    file.value = nextFile;
    analysis.value = nextAnalysis;
  }

  function clear() {
    file.value = null;
    analysis.value = null;
  }

  return { file, analysis, setKeyBpm, clear };
});
