ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_fit_review_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_fit_review_request_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_fit_review_opportunity_id" uuid;--> statement-breakpoint
UPDATE "users" SET "first_fit_review_used" = true WHERE EXISTS (SELECT 1 FROM "fit_reviews" WHERE "fit_reviews"."user_id" = "users"."id");
