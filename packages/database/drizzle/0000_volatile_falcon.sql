CREATE TYPE "public"."audio_asset_kind" AS ENUM('source', 'stem', 'preview', 'mix', 'export');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('debug', 'info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'detecting', 'awaiting_confirmation', 'separating', 'rendering', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'analyzing', 'awaiting_confirmation', 'separating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."separation_mode" AS ENUM('quick', 'standard', 'auto');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "analysis_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audio_asset_id" uuid NOT NULL,
	"analysis_type" text NOT NULL,
	"result" jsonb NOT NULL,
	"model_or_algorithm" text NOT NULL,
	"version" text NOT NULL,
	"confidence" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_results_confidence_range" CHECK ("analysis_results"."confidence" IS NULL OR ("analysis_results"."confidence" >= 0 AND "analysis_results"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "audio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "audio_asset_kind" NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"sample_rate" integer,
	"channels" integer,
	"codec" text,
	"bitrate" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "audio_assets_size_positive" CHECK ("audio_assets"."size_bytes" > 0),
	CONSTRAINT "audio_assets_duration_nonnegative" CHECK ("audio_assets"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "instrument_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"canonical_label" text NOT NULL,
	"display_label" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"detected_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"manually_added" boolean DEFAULT false NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_detections_confidence_range" CHECK ("instrument_detections"."confidence" >= 0 AND "instrument_detections"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "mix_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"master_settings" jsonb DEFAULT '{"volumeDb":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mix_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mix_session_id" uuid NOT NULL,
	"stem_id" uuid,
	"audio_asset_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"start_ms" integer DEFAULT 0 NOT NULL,
	"trim_start_ms" integer DEFAULT 0 NOT NULL,
	"trim_end_ms" integer DEFAULT 0 NOT NULL,
	"volume_db" numeric(6, 2) DEFAULT 0 NOT NULL,
	"pan" numeric(4, 3) DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"solo" boolean DEFAULT false NOT NULL,
	"fade_in_ms" integer DEFAULT 0 NOT NULL,
	"fade_out_ms" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mix_tracks_start_nonnegative" CHECK ("mix_tracks"."start_ms" >= 0),
	CONSTRAINT "mix_tracks_trim_start_nonnegative" CHECK ("mix_tracks"."trim_start_ms" >= 0),
	CONSTRAINT "mix_tracks_trim_end_nonnegative" CHECK ("mix_tracks"."trim_end_ms" >= 0),
	CONSTRAINT "mix_tracks_volume_range" CHECK ("mix_tracks"."volume_db" >= -60 AND "mix_tracks"."volume_db" <= 12),
	CONSTRAINT "mix_tracks_pan_range" CHECK ("mix_tracks"."pan" >= -1 AND "mix_tracks"."pan" <= 1),
	CONSTRAINT "mix_tracks_fade_in_nonnegative" CHECK ("mix_tracks"."fade_in_ms" >= 0),
	CONSTRAINT "mix_tracks_fade_out_nonnegative" CHECK ("mix_tracks"."fade_out_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "processing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"level" "event_level" DEFAULT 'info' NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"source_audio_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "separation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" "separation_mode" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"current_stage" text,
	"provider" text NOT NULL,
	"model_name" text,
	"model_version" text,
	"error_code" text,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "separation_jobs_progress_range" CHECK ("separation_jobs"."progress" >= 0 AND "separation_jobs"."progress" <= 100)
);
--> statement-breakpoint
CREATE TABLE "stems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"audio_asset_id" uuid NOT NULL,
	"instrument_detection_id" uuid,
	"canonical_label" text NOT NULL,
	"instance_index" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(5, 4),
	"is_residual" boolean DEFAULT false NOT NULL,
	"processing_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stems_instance_nonnegative" CHECK ("stems"."instance_index" >= 0),
	CONSTRAINT "stems_confidence_range" CHECK ("stems"."confidence" IS NULL OR ("stems"."confidence" >= 0 AND "stems"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_audio_asset_id_audio_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_detections" ADD CONSTRAINT "instrument_detections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_sessions" ADD CONSTRAINT "mix_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_tracks" ADD CONSTRAINT "mix_tracks_mix_session_id_mix_sessions_id_fk" FOREIGN KEY ("mix_session_id") REFERENCES "public"."mix_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_tracks" ADD CONSTRAINT "mix_tracks_stem_id_stems_id_fk" FOREIGN KEY ("stem_id") REFERENCES "public"."stems"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mix_tracks" ADD CONSTRAINT "mix_tracks_audio_asset_id_audio_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_events" ADD CONSTRAINT "processing_events_job_id_separation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."separation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_audio_id_audio_assets_id_fk" FOREIGN KEY ("source_audio_id") REFERENCES "public"."audio_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "separation_jobs" ADD CONSTRAINT "separation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stems" ADD CONSTRAINT "stems_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stems" ADD CONSTRAINT "stems_job_id_separation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."separation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stems" ADD CONSTRAINT "stems_audio_asset_id_audio_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stems" ADD CONSTRAINT "stems_instrument_detection_id_instrument_detections_id_fk" FOREIGN KEY ("instrument_detection_id") REFERENCES "public"."instrument_detections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_results_audio_asset_id_idx" ON "analysis_results" USING btree ("audio_asset_id");--> statement-breakpoint
CREATE INDEX "analysis_results_type_idx" ON "analysis_results" USING btree ("analysis_type");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_assets_storage_key_unique" ON "audio_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "audio_assets_project_id_idx" ON "audio_assets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "audio_assets_checksum_idx" ON "audio_assets" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE INDEX "audio_assets_created_at_idx" ON "audio_assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "instrument_detections_project_id_idx" ON "instrument_detections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "instrument_detections_label_idx" ON "instrument_detections" USING btree ("canonical_label");--> statement-breakpoint
CREATE UNIQUE INDEX "mix_sessions_project_name_unique" ON "mix_sessions" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "mix_sessions_project_id_idx" ON "mix_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mix_tracks_session_id_idx" ON "mix_tracks" USING btree ("mix_session_id");--> statement-breakpoint
CREATE INDEX "mix_tracks_stem_id_idx" ON "mix_tracks" USING btree ("stem_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mix_tracks_session_order_unique" ON "mix_tracks" USING btree ("mix_session_id","order_index");--> statement-breakpoint
CREATE INDEX "processing_events_job_id_idx" ON "processing_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "processing_events_created_at_idx" ON "processing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "separation_jobs_project_id_idx" ON "separation_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "separation_jobs_status_idx" ON "separation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "separation_jobs_queued_at_idx" ON "separation_jobs" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "stems_project_id_idx" ON "stems" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "stems_job_id_idx" ON "stems" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "stems_audio_asset_id_idx" ON "stems" USING btree ("audio_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stems_job_label_instance_unique" ON "stems" USING btree ("job_id","canonical_label","instance_index");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");