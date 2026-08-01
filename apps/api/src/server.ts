import "dotenv/config";

import { loadConfig } from "@audiotool/config";

import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(
    {
      host: config.API_HOST,
      port: config.API_PORT,
      mlProvider: config.ML_PROVIDER,
      queueMode: config.QUEUE_MODE,
    },
    "AudioTool API listening",
  );
} catch (error) {
  app.log.fatal({ err: error }, "Unable to start AudioTool API");
  process.exit(1);
}
