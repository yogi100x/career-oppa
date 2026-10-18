CREATE TABLE "resume_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer NOT NULL,
	"grounding_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_version" text,
	"model" text,
	"restored_from_id" uuid,
	"approved_at" timestamp with time zone,
	"pdf_file_id" uuid,
	"page_size" text DEFAULT 'A4' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_pdf_file_id_files_id_fk" FOREIGN KEY ("pdf_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_versions_opportunity_version_unique" ON "resume_versions" USING btree ("opportunity_id","version");--> statement-breakpoint
CREATE INDEX "resume_versions_user_opportunity_idx" ON "resume_versions" USING btree ("user_id","opportunity_id");