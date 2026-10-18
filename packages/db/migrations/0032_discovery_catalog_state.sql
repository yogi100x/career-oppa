ALTER TABLE public_job_discovery_sources
  ADD COLUMN IF NOT EXISTS catalog_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dead_until_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS public_job_discovery_sources_catalog_retry_idx
  ON public_job_discovery_sources USING btree (catalog_active, next_retry_at);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'public_job_discovery_sources_failure_count_check'
      AND conrelid = to_regclass(format('%I.%I', current_schema(), 'public_job_discovery_sources'))
  ) THEN
    ALTER TABLE public_job_discovery_sources
      ADD CONSTRAINT public_job_discovery_sources_failure_count_check
      CHECK (failure_count >= 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS discovery_collection_state (
  id text PRIMARY KEY DEFAULT 'global' NOT NULL,
  cursor integer DEFAULT 0 NOT NULL,
  dataset_fetched_at timestamp with time zone,
  dataset_attempt_at timestamp with time zone,
  dataset_claim_token uuid,
  dataset_claimed_at timestamp with time zone,
  dataset_error text,
  current_sweep_key text,
  CONSTRAINT discovery_collection_state_global_id_check CHECK (id = 'global'),
  CONSTRAINT discovery_collection_state_cursor_check CHECK (cursor >= 0)
);
--> statement-breakpoint
ALTER TABLE discovery_collection_state
  ADD COLUMN IF NOT EXISTS current_sweep_key text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS discovery_sweeps (
  key text PRIMARY KEY NOT NULL,
  source_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  consecutive_failures integer DEFAULT 0 NOT NULL,
  halted boolean DEFAULT false NOT NULL,
  next_index integer DEFAULT 0 NOT NULL,
  refreshed integer DEFAULT 0 NOT NULL,
  failed integer DEFAULT 0 NOT NULL,
  skipped integer DEFAULT 0 NOT NULL,
  lease_token uuid,
  lease_until timestamp with time zone,
  CONSTRAINT discovery_sweeps_source_ids_array_check CHECK (jsonb_typeof(source_ids) = 'array'),
  CONSTRAINT discovery_sweeps_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT discovery_sweeps_next_index_check CHECK (next_index >= 0),
  CONSTRAINT discovery_sweeps_refreshed_check CHECK (refreshed >= 0),
  CONSTRAINT discovery_sweeps_failed_check CHECK (failed >= 0),
  CONSTRAINT discovery_sweeps_skipped_check CHECK (skipped >= 0)
);
--> statement-breakpoint
ALTER TABLE discovery_sweeps
  ADD COLUMN IF NOT EXISTS next_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refreshed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sweeps_next_index_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'discovery_sweeps'))) THEN
    ALTER TABLE discovery_sweeps ADD CONSTRAINT discovery_sweeps_next_index_check CHECK (next_index >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sweeps_refreshed_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'discovery_sweeps'))) THEN
    ALTER TABLE discovery_sweeps ADD CONSTRAINT discovery_sweeps_refreshed_check CHECK (refreshed >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sweeps_failed_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'discovery_sweeps'))) THEN
    ALTER TABLE discovery_sweeps ADD CONSTRAINT discovery_sweeps_failed_check CHECK (failed >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sweeps_skipped_check' AND conrelid = to_regclass(format('%I.%I', current_schema(), 'discovery_sweeps'))) THEN
    ALTER TABLE discovery_sweeps ADD CONSTRAINT discovery_sweeps_skipped_check CHECK (skipped >= 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS discovery_job_sightings (
  canonical_url_hash text PRIMARY KEY NOT NULL,
  source_id text NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT discovery_job_sightings_source_id_public_job_discovery_sources_id_fk
    FOREIGN KEY (source_id) REFERENCES public_job_discovery_sources(id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discovery_job_sightings_source_idx
  ON discovery_job_sightings USING btree (source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS public_job_discovery_jobs_active_freshness_idx
  ON public_job_discovery_jobs USING btree (active, (COALESCE(posted_at, first_seen_at)));
--> statement-breakpoint
INSERT INTO discovery_job_sightings (canonical_url_hash, source_id, first_seen_at, last_seen_at)
SELECT canonical_url_hash, source_id, first_seen_at, last_seen_at
FROM public_job_discovery_jobs
ON CONFLICT (canonical_url_hash) DO UPDATE
SET first_seen_at = LEAST(discovery_job_sightings.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at = GREATEST(discovery_job_sightings.last_seen_at, EXCLUDED.last_seen_at);
