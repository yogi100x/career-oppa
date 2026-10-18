ALTER TABLE "resume_versions" ADD COLUMN IF NOT EXISTS "reused_from_id" uuid;
--> statement-breakpoint
-- Earlier copies used restore provenance. Preserve the source, but only move
-- rows whose source belongs to the same person and a different opportunity.
UPDATE "resume_versions" AS copied
SET "reused_from_id" = source.id, "restored_from_id" = NULL
FROM "resume_versions" AS source
WHERE copied.restored_from_id = source.id
  AND copied.user_id = source.user_id
  AND copied.opportunity_id <> source.opportunity_id
  AND copied.reused_from_id IS NULL;
--> statement-breakpoint
UPDATE "events" AS event
SET "type" = 'resume.reused',
    "data" = event.data || jsonb_build_object('reusedFromId', copied.reused_from_id)
FROM "resume_versions" AS copied
WHERE event.type = 'resume.restored'
  AND event.user_id = copied.user_id
  AND event.data->>'resumeId' = copied.id::text
  AND copied.reused_from_id IS NOT NULL;
