ALTER TABLE "fit_reviews" ADD COLUMN IF NOT EXISTS "is_free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fit_reviews" ADD COLUMN IF NOT EXISTS "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fit_reviews_one_free_per_user_unique" ON "fit_reviews" USING btree ("user_id") WHERE "fit_reviews"."is_free";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fit_reviews_user_request_key_unique" ON "fit_reviews" USING btree ("user_id","request_key") WHERE "fit_reviews"."request_key" IS NOT NULL;
