import { resolve } from "node:path";

import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  INTERNAL_API_KEY: z.string().trim().min(32),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_ROOT: z.string().default("./storage"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(524_288_000),
  MAX_AUDIO_DURATION_MS: z.coerce.number().int().positive().default(7_200_000),
  MAX_PROJECTS_PER_USER: z.coerce.number().int().positive().default(100),
  MAX_STORAGE_BYTES_PER_USER: z.coerce.number().int().positive().default(10_737_418_240),
  MAX_CONCURRENT_JOBS_PER_USER: z.coerce.number().int().positive().default(1),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  TEMP_FILE_TTL_HOURS: z.coerce.number().positive().default(24),
  PROJECT_RETENTION_DAYS: z.coerce.number().nonnegative().default(30),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().positive().default(60),
  QUEUE_MODE: z.enum(["inline", "bullmq"]).default("inline"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ML_PROVIDER: z
    .enum(["mock", "http", "demucs_http", "banquet_http", "sam_audio_http", "audiosep_http"])
    .default("mock"),
  ML_WORKER_URL: z.string().url().default("http://localhost:8000"),
  ML_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  GUIDE_TTS_PROVIDER: z.enum(["auto", "groq", "edge", "system"]).default("auto"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_TTS_MODEL: z.string().default("canopylabs/orpheus-v1-english"),
  GROQ_TTS_VOICE: z.enum(["autumn", "diana", "hannah"]).default("hannah"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  TEMP_ROOT: z.string().default("./tmp"),
  VIRUS_SCAN_MODE: z.enum(["disabled", "clamav"]).default("disabled"),
  CLAMSCAN_PATH: z.string().default("clamscan"),
  VIRUS_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  YTDLP_PATH: z.string().default("yt-dlp"),
  TRUST_PROXY: booleanString,
}).superRefine((data, context) => {
  if (data.NODE_ENV === "production" && data.VIRUS_SCAN_MODE === "disabled") {
    context.addIssue({
      code: "custom",
      path: ["VIRUS_SCAN_MODE"],
      message: "Production requires VIRUS_SCAN_MODE=clamav.",
    });
  }
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }

  const data = parsed.data;
  return {
    ...data,
    storageLocalRoot: resolve(data.STORAGE_LOCAL_ROOT),
    tempRoot: resolve(data.TEMP_ROOT),
  };
}
