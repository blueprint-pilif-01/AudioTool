import "@fontsource-variable/plus-jakarta-sans";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { createApp, type Component } from "vue";

import App from "./App.vue";
import { router } from "./router";
import "./styles/main.css";

createApp(App as Component)
  .use(createPinia())
  .use(VueQueryPlugin)
  .use(router)
  .mount("#app");
