ALTER TABLE "publishing_events" ADD COLUMN "user_id" uuid;--> statement-breakpoint
UPDATE "publishing_events" AS event SET "user_id" = post."user_id" FROM "posts" AS post WHERE post."provider_post_id" = event."provider_post_id";--> statement-breakpoint
UPDATE "publishing_events" AS event SET "user_id" = connection."user_id" FROM "social_connections" AS connection WHERE event."user_id" IS NULL AND connection."provider_account_id" = event."payload"->>'accountId' AND connection."platform" = event."payload"->>'platform';--> statement-breakpoint
DELETE FROM "publishing_events" WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "publishing_events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "publishing_events" ADD CONSTRAINT "publishing_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
