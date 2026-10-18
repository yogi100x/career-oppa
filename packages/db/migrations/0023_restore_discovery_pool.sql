CREATE TABLE IF NOT EXISTS "public_job_discovery_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"board" text NOT NULL,
	"company" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"error_code" text,
	"claim_token" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_job_discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"canonical_url_hash" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text NOT NULL,
	"work_mode" text NOT NULL,
	"url" text NOT NULL,
	"text" text NOT NULL,
	"posted_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_job_discovery_sources_status_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_sources'))) THEN
		ALTER TABLE "public_job_discovery_sources" ADD CONSTRAINT "public_job_discovery_sources_status_check" CHECK ("status" IN ('idle', 'running', 'succeeded', 'failed'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_job_discovery_jobs_work_mode_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_jobs'))) THEN
		ALTER TABLE "public_job_discovery_jobs" ADD CONSTRAINT "public_job_discovery_jobs_work_mode_check" CHECK ("work_mode" IN ('remote', 'hybrid', 'onsite', 'unknown'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_job_discovery_jobs_source_id_public_job_discovery_sources_id_fk' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_jobs'))) THEN
		ALTER TABLE "public_job_discovery_jobs" ADD CONSTRAINT "public_job_discovery_jobs_source_id_public_job_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public_job_discovery_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_job_discovery_jobs_canonical_url_hash_unique" ON "public_job_discovery_jobs" USING btree ("canonical_url_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_job_discovery_jobs_source_external_unique" ON "public_job_discovery_jobs" USING btree ("source_id", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_job_discovery_jobs_active_last_seen_idx" ON "public_job_discovery_jobs" USING btree ("active", "last_seen_at");
