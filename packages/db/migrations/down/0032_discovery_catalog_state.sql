DROP INDEX IF EXISTS public_job_discovery_jobs_active_freshness_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS discovery_job_sightings_source_idx;
--> statement-breakpoint
DROP TABLE IF EXISTS discovery_job_sightings;
--> statement-breakpoint
DROP TABLE IF EXISTS discovery_sweeps;
--> statement-breakpoint
DROP TABLE IF EXISTS discovery_collection_state;
--> statement-breakpoint
DROP INDEX IF EXISTS public_job_discovery_sources_catalog_retry_idx;
--> statement-breakpoint
ALTER TABLE public_job_discovery_sources
  DROP COLUMN IF EXISTS next_retry_at,
  DROP COLUMN IF EXISTS dead_until_at,
  DROP COLUMN IF EXISTS failure_count,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS catalog_active;
