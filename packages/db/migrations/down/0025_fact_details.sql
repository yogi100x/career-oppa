-- Reverses 0025 by hand if needed. The migrator never runs files in down/.
-- Facts using the new kinds must be removed or re-kinded first.
ALTER TABLE "profile_facts" DROP CONSTRAINT IF EXISTS "profile_facts_kind_check";
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_kind_check" CHECK ("profile_facts"."kind" IN ('experience', 'skill', 'education', 'achievement', 'certification', 'project'));
ALTER TABLE "profile_facts" DROP COLUMN IF EXISTS "source_quote";
ALTER TABLE "profile_facts" DROP COLUMN IF EXISTS "end_date";
ALTER TABLE "profile_facts" DROP COLUMN IF EXISTS "start_date";
ALTER TABLE "profile_facts" DROP COLUMN IF EXISTS "role";
ALTER TABLE "profile_facts" DROP COLUMN IF EXISTS "organisation";
