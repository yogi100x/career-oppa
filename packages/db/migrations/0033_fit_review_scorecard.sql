ALTER TABLE "fit_reviews" ADD COLUMN IF NOT EXISTS "scorecard" jsonb;
--> statement-breakpoint
ALTER TABLE "fit_reviews" ADD COLUMN IF NOT EXISTS "requirements" jsonb;
