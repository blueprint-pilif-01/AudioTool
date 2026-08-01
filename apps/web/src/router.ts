import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      redirect: "/projects",
    },
    {
      path: "/projects",
      name: "projects",
      component: () => import("./pages/ProjectsPage.vue"),
    },
    {
      path: "/projects/new",
      name: "project-new",
      component: () => import("./pages/NewProjectPage.vue"),
    },
    {
      path: "/projects/:id/analyze",
      name: "project-analyze",
      component: () => import("./pages/AnalyzePage.vue"),
    },
    {
      path: "/projects/:id/instruments",
      name: "project-instruments",
      component: () => import("./pages/InstrumentsPage.vue"),
    },
    {
      path: "/projects/:id/separation",
      name: "project-separation",
      component: () => import("./pages/SeparationPage.vue"),
    },
    {
      path: "/projects/:id/mixer",
      name: "project-mixer",
      component: () => import("./pages/MixerPage.vue"),
      meta: { wide: true },
    },
    {
      path: "/projects/:id/guide-click",
      name: "project-guide-click",
      component: () => import("./pages/GuideClickPage.vue"),
      meta: { wide: true },
    },
    {
      path: "/projects/:id/vocal-breakdown",
      name: "project-vocal-breakdown",
      component: () => import("./pages/VocalBreakdownPage.vue"),
      meta: { wide: true },
    },
    {
      path: "/tools/vocal-remover",
      component: () => import("./pages/tools/QuickSeparatePage.vue"),
      props: { mode: "vocal-remover" },
    },
    {
      path: "/tools/splitter",
      component: () => import("./pages/tools/QuickSeparatePage.vue"),
      props: { mode: "splitter" },
    },
    {
      path: "/tools/pitch-tempo",
      component: () => import("./pages/tools/PitchTempoPage.vue"),
    },
    {
      path: "/tools/key-bpm",
      component: () => import("./pages/tools/KeyBpmPage.vue"),
    },
    {
      path: "/tools/cutter",
      component: () => import("./pages/tools/CutterPage.vue"),
    },
    {
      path: "/tools/joiner",
      component: () => import("./pages/tools/JoinerPage.vue"),
    },
    {
      path: "/:pathMatch(.*)*",
      component: () => import("./pages/NotFoundPage.vue"),
      meta: { public: true },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
