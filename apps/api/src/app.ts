import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { createMockStem } from "@audiotool/audio-engine";
import { loadConfig, type AppConfig } from "@audiotool/config";
import { createDatabase } from "@audiotool/database";

import { registerErrorHandler } from "./errors.js";
import { registerAudioRoutes } from "./http/audio-routes.js";
import { registerDetectionAndJobRoutes } from "./http/detection-job-routes.js";
import { registerHealthRoutes } from "./http/health-routes.js";
import { registerGuideTrackRoutes } from "./http/guide-track-routes.js";
import { registerProjectRoutes } from "./http/project-routes.js";
import { registerStemAndMixRoutes } from "./http/stem-mix-routes.js";
import { registerToolRoutes } from "./http/tool-routes.js";
import { registerVocalBreakdownRoutes } from "./http/vocal-breakdown-routes.js";
import type { ApiContext } from "./http/types.js";
import { JobEventHub } from "./services/event-hub.js";
import { BullMqJobDispatcher, InlineJobDispatcher } from "./services/job-dispatcher.js";
import { JobProcessor } from "./services/job-processor.js";
import {
  AudioSepHttpProvider,
  BanquetHttpProvider,
  DemucsHttpProvider,
  HttpMlProvider,
  MockMlProvider,
  SamAudioHttpProvider,
  type MlProvider,
} from "./services/ml-provider.js";
import { LocalStorageService } from "./services/storage.js";
import { CleanupService } from "./services/cleanup-service.js";
import { registerInternalAuthentication } from "./services/internal-auth.js";
import { createVirusScanner } from "./services/virus-scanner.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app: FastifyInstance = Fastify({
    logger: options.logger !== false,
    trustProxy: config.TRUST_PROXY,
    requestIdHeader: "x-request-id",
  });
  if (config.STORAGE_DRIVER !== "local") {
    throw new Error(
      "STORAGE_DRIVER=s3 is reserved but not implemented in milestone one. Use local storage until the S3 adapter is installed.",
    );
  }
  const { db, pool } = createDatabase(config.DATABASE_URL);
  const storage = new LocalStorageService(
    config.storageLocalRoot,
    config.tempRoot,
    config.MAX_UPLOAD_BYTES,
  );
  await storage.initialize();
  const eventHub = new JobEventHub();
  let provider: MlProvider;
  if (config.ML_PROVIDER === "mock") {
    provider = new MockMlProvider((inputPath, outputPath, stemOptions) =>
      createMockStem(inputPath, outputPath, {
        ffmpegPath: config.FFMPEG_PATH,
        gainDb: stemOptions.gainDb,
        ...(stemOptions.signal ? { signal: stemOptions.signal } : {}),
      }),
    );
  } else {
    const Provider = {
      http: HttpMlProvider,
      demucs_http: DemucsHttpProvider,
      banquet_http: BanquetHttpProvider,
      sam_audio_http: SamAudioHttpProvider,
      audiosep_http: AudioSepHttpProvider,
    }[config.ML_PROVIDER];
    provider = new Provider(config.ML_WORKER_URL, config.ML_REQUEST_TIMEOUT_MS);
  }
  const processor = new JobProcessor({
    db,
    storage,
    provider,
    eventHub,
    ffmpegPath: config.FFMPEG_PATH,
    ffprobePath: config.FFPROBE_PATH,
    onError: (error, jobId) => {
      app.log.error({ err: error, jobId }, "Background audio job failed");
    },
  });
  const jobProcessor =
    config.QUEUE_MODE === "bullmq"
      ? new BullMqJobDispatcher(config.REDIS_URL, processor, app.log)
      : new InlineJobDispatcher(processor);
  const scanner = createVirusScanner(config);
  const context: ApiContext = { config, db, storage, provider, eventHub, jobProcessor, scanner };
  const cleanup = new CleanupService({
    db,
    storage,
    logger: app.log,
    tempFileTtlHours: config.TEMP_FILE_TTL_HOURS,
    projectRetentionDays: config.PROJECT_RETENTION_DAYS,
    intervalMinutes: config.CLEANUP_INTERVAL_MINUTES,
  });
  cleanup.start();

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: {
      files: 20,
      fileSize: config.MAX_UPLOAD_BYTES,
      fields: 10,
    },
  });
  registerInternalAuthentication(app, context);
  await app.register(rateLimit, {
    global: true,
    max: config.API_RATE_LIMIT_MAX,
    timeWindow: config.API_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => request.audioToolIdentity?.userId ?? request.ip,
    allowList: (request) => request.url === "/health" || request.url === "/ready",
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AudioTool API",
        description:
          "Projects, dynamic instrument detection, stem separation and multitrack editing.",
        version: "0.1.0",
      },
      servers: [{ url: `http://${config.API_HOST}:${config.API_PORT}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  registerErrorHandler(app);
  registerHealthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerAudioRoutes(app, context);
  registerGuideTrackRoutes(app, context);
  registerVocalBreakdownRoutes(app, context);
  registerDetectionAndJobRoutes(app, context);
  registerStemAndMixRoutes(app, context);
  registerToolRoutes(app, context);

  app.addHook("onClose", async () => {
    cleanup.close();
    await jobProcessor.close();
    await pool.end();
  });

  return app;
}
