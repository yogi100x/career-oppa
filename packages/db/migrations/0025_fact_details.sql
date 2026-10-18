ALTER TABLE "profile_facts" DROP CONSTRAINT IF EXISTS "profile_facts_kind_check";--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN IF NOT EXISTS "organisation" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN IF NOT EXISTS "role" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN IF NOT EXISTS "start_date" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN IF NOT EXISTS "end_date" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN IF NOT EXISTS "source_quote" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_kind_check" CHECK ("profile_facts"."kind" IN ('experience', 'skill', 'education', 'achievement', 'certification', 'project', 'volunteering', 'responsibility', 'language', 'eligibility'));
