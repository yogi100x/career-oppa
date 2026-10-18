ALTER TABLE "resume_versions" ADD COLUMN IF NOT EXISTS "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resume_versions_user_opportunity_request_key_unique" ON "resume_versions" USING btree ("user_id","opportunity_id","request_key");
