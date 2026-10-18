DROP INDEX IF EXISTS "fit_reviews_user_request_key_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "fit_reviews_one_free_per_user_unique";
--> statement-breakpoint
ALTER TABLE "fit_reviews" DROP COLUMN IF EXISTS "request_key";
--> statement-breakpoint
ALTER TABLE "fit_reviews" DROP COLUMN IF EXISTS "is_free";
