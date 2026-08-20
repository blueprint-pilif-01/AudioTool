import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const repoRoot = resolve(import.meta.dirname, "../..");

function localApiProxy(env: Record<string, string>): ProxyOptions {
  const apiKey = env.INTERNAL_API_KEY?.trim();
  const userId = env.DEV_INTERNAL_USER_ID?.trim() || "1";
  const apiPort = env.API_PORT || "3000";
  return {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        if (apiKey) {
          proxyReq.removeHeader("Authorization");
          proxyReq.setHeader("Authorization", `Bearer ${apiKey}`);
        }
        proxyReq.removeHeader("X-AudioTool-User-Id");
        proxyReq.removeHeader("X-AudioTool-User-Name");
        proxyReq.setHeader("X-AudioTool-User-Id", userId);
        proxyReq.setHeader("X-AudioTool-User-Name", encodeURIComponent("Local developer"));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiProxy = localApiProxy(env);
  return {
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        "/api": apiProxy,
      },
    },
    preview: {
      port: 4173,
      proxy: {
        "/api": apiProxy,
      },
    },
  };
});
