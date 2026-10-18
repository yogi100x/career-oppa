ALTER TABLE "files" DROP CONSTRAINT "files_kind_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "target_roles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_location" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_preference" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paper_size" text DEFAULT 'A4' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_kind_check" CHECK ("files"."kind" IN ('cv_upload', 'resume_pdf', 'portfolio', 'supporting_document'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_work_preference_check" CHECK ("users"."work_preference" IN ('any', 'remote', 'hybrid', 'onsite'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_paper_size_check" CHECK ("users"."paper_size" IN ('A4', 'LETTER'));