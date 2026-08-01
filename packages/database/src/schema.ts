import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import {
  audioAssetKinds,
  jobStatuses,
  projectStatuses,
  separationModes,
} from "@audiotool/contracts";

export const projectStatusEnum = pgEnum("project_status", projectStatuses);
export const jobStatusEnum = pgEnum("job_status", jobStatuses);
export const separationModeEnum = pgEnum("separation_mode", separationModes);
export const audioAssetKindEnum = pgEnum("audio_asset_kind", audioAssetKinds);
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const eventLevelEnum = pgEnum("event_level", ["debug", "info", "warning", "error"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull(),
    role: userRoleEnum("role").default("user").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: projectStatusEnum("status").default("draft").notNull(),
    sourceAudioId: uuid("source_audio_id").references((): AnyPgColumn => audioAssets.id, {
      onDelete: "set null",
    }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("projects_user_id_idx").on(table.userId),
    index("projects_status_idx").on(table.status),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

export const audioAssets = pgTable(
  "audio_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: audioAssetKindEnum("kind").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    extension: text("extension").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    durationMs: integer("duration_ms").notNull(),
    sampleRate: integer("sample_rate"),
    channels: integer("channels"),
    codec: text("codec"),
    bitrate: integer("bitrate"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("audio_assets_storage_key_unique").on(table.storageKey),
    index("audio_assets_project_id_idx").on(table.projectId),
    index("audio_assets_checksum_idx").on(table.checksumSha256),
    index("audio_assets_created_at_idx").on(table.createdAt),
    check("audio_assets_size_positive", sql`${table.sizeBytes} > 0`),
    check("audio_assets_duration_nonnegative", sql`${table.durationMs} >= 0`),
  ],
);

export const instrumentDetections = pgTable(
  "instrument_detections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    canonicalLabel: text("canonical_label").notNull(),
    displayLabel: text("display_label").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }).notNull(),
    detectedSpans: jsonb("detected_spans")
      .$type<Array<{ startMs: number; endMs: number }>>()
      .default([])
      .notNull(),
    selected: boolean("selected").default(true).notNull(),
    manuallyAdded: boolean("manually_added").default(false).notNull(),
    modelName: text("model_name").notNull(),
    modelVersion: text("model_version").notNull(),
    ...timestamps,
  },
  (table) => [
    index("instrument_detections_project_id_idx").on(table.projectId),
    index("instrument_detections_label_idx").on(table.canonicalLabel),
    check(
      "instrument_detections_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export const separationJobs = pgTable(
  "separation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: separationModeEnum("mode").notNull(),
    status: jobStatusEnum("status").default("queued").notNull(),
    progress: integer("progress").default(0).notNull(),
    currentStage: text("current_stage"),
    provider: text("provider").notNull(),
    modelName: text("model_name"),
    modelVersion: text("model_version"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    options: jsonb("options").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    index("separation_jobs_project_id_idx").on(table.projectId),
    index("separation_jobs_status_idx").on(table.status),
    index("separation_jobs_queued_at_idx").on(table.queuedAt),
    check(
      "separation_jobs_progress_range",
      sql`${table.progress} >= 0 AND ${table.progress} <= 100`,
    ),
  ],
);

export const stems = pgTable(
  "stems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => separationJobs.id, { onDelete: "cascade" }),
    audioAssetId: uuid("audio_asset_id")
      .notNull()
      .references(() => audioAssets.id, { onDelete: "restrict" }),
    instrumentDetectionId: uuid("instrument_detection_id").references(
      () => instrumentDetections.id,
      { onDelete: "set null" },
    ),
    canonicalLabel: text("canonical_label").notNull(),
    instanceIndex: integer("instance_index").default(0).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }),
    isResidual: boolean("is_residual").default(false).notNull(),
    processingMetadata: jsonb("processing_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("stems_project_id_idx").on(table.projectId),
    index("stems_job_id_idx").on(table.jobId),
    index("stems_audio_asset_id_idx").on(table.audioAssetId),
    uniqueIndex("stems_job_label_instance_unique").on(
      table.jobId,
      table.canonicalLabel,
      table.instanceIndex,
    ),
    check("stems_instance_nonnegative", sql`${table.instanceIndex} >= 0`),
    check(
      "stems_confidence_range",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  ],
);

export const mixSessions = pgTable(
  "mix_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    masterSettings: jsonb("master_settings")
      .$type<{ volumeDb: number }>()
      .default({ volumeDb: 0 })
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mix_sessions_project_name_unique").on(table.projectId, table.name),
    index("mix_sessions_project_id_idx").on(table.projectId),
  ],
);

export const mixTracks = pgTable(
  "mix_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mixSessionId: uuid("mix_session_id")
      .notNull()
      .references(() => mixSessions.id, { onDelete: "cascade" }),
    stemId: uuid("stem_id").references(() => stems.id, { onDelete: "set null" }),
    audioAssetId: uuid("audio_asset_id")
      .notNull()
      .references(() => audioAssets.id, { onDelete: "restrict" }),
    orderIndex: integer("order_index").notNull(),
    startMs: integer("start_ms").default(0).notNull(),
    trimStartMs: integer("trim_start_ms").default(0).notNull(),
    trimEndMs: integer("trim_end_ms").default(0).notNull(),
    volumeDb: numeric("volume_db", { precision: 6, scale: 2, mode: "number" }).default(0).notNull(),
    pan: numeric("pan", { precision: 4, scale: 3, mode: "number" }).default(0).notNull(),
    muted: boolean("muted").default(false).notNull(),
    solo: boolean("solo").default(false).notNull(),
    fadeInMs: integer("fade_in_ms").default(0).notNull(),
    fadeOutMs: integer("fade_out_ms").default(0).notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    index("mix_tracks_session_id_idx").on(table.mixSessionId),
    index("mix_tracks_stem_id_idx").on(table.stemId),
    uniqueIndex("mix_tracks_session_order_unique").on(table.mixSessionId, table.orderIndex),
    check("mix_tracks_start_nonnegative", sql`${table.startMs} >= 0`),
    check("mix_tracks_trim_start_nonnegative", sql`${table.trimStartMs} >= 0`),
    check("mix_tracks_trim_end_nonnegative", sql`${table.trimEndMs} >= 0`),
    check("mix_tracks_volume_range", sql`${table.volumeDb} >= -60 AND ${table.volumeDb} <= 12`),
    check("mix_tracks_pan_range", sql`${table.pan} >= -1 AND ${table.pan} <= 1`),
    check("mix_tracks_fade_in_nonnegative", sql`${table.fadeInMs} >= 0`),
    check("mix_tracks_fade_out_nonnegative", sql`${table.fadeOutMs} >= 0`),
  ],
);

export const analysisResults = pgTable(
  "analysis_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    audioAssetId: uuid("audio_asset_id")
      .notNull()
      .references(() => audioAssets.id, { onDelete: "cascade" }),
    analysisType: text("analysis_type").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    modelOrAlgorithm: text("model_or_algorithm").notNull(),
    version: text("version").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("analysis_results_audio_asset_id_idx").on(table.audioAssetId),
    index("analysis_results_type_idx").on(table.analysisType),
    check(
      "analysis_results_confidence_range",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  ],
);

export const processingEvents = pgTable(
  "processing_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => separationJobs.id, { onDelete: "cascade" }),
    level: eventLevelEnum("level").default("info").notNull(),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("processing_events_job_id_idx").on(table.jobId),
    index("processing_events_created_at_idx").on(table.createdAt),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type AudioAssetRow = typeof audioAssets.$inferSelect;
export type InstrumentDetectionRow = typeof instrumentDetections.$inferSelect;
export type SeparationJobRow = typeof separationJobs.$inferSelect;
export type StemRow = typeof stems.$inferSelect;
export type MixSessionRow = typeof mixSessions.$inferSelect;
export type MixTrackRow = typeof mixTracks.$inferSelect;
