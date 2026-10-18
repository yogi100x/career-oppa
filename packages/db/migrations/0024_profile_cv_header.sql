ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cv_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cv_contact" text DEFAULT '' NOT NULL;
