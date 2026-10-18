DROP INDEX IF EXISTS "resume_versions_user_opportunity_request_key_unique";--> statement-breakpoint
ALTER TABLE "resume_versions" DROP COLUMN IF EXISTS "request_key";
