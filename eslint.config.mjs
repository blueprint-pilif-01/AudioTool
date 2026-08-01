import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/drizzle/**",
      ".*/**",
      "apps/ml-worker/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".cursor/**",
      ".gemini/**",
      ".github/**",
      ".impeccable/**",
      ".kiro/**",
      ".opencode/**",
      ".pi/**",
      ".qoder/**",
      ".trae/**",
      ".trae-cn/**",
      "agent/**",
      "data/**",
      "skills/**",
    ],
  },
  eslint.configs.recommended,
  ...pluginVue.configs["flat/essential"],
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  {
    files: ["**/*.vue"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  prettier,
);
