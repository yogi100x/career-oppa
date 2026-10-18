CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source_file_id" uuid,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_facts_kind_check" CHECK ("profile_facts"."kind" IN ('experience', 'skill', 'education', 'achievement', 'certification', 'project')),
	CONSTRAINT "profile_facts_source_check" CHECK ("profile_facts"."source" IN ('cv', 'user', 'chat', 'project')),
	CONSTRAINT "profile_facts_status_check" CHECK ("profile_facts"."status" IN ('proposed', 'approved', 'rejected')),
	CONSTRAINT "profile_facts_text_nonempty_check" CHECK (length(trim("profile_facts"."text")) > 0),
	CONSTRAINT "profile_facts_project_source_check" CHECK (("profile_facts"."source" = 'project' AND "profile_facts"."project_id" IS NOT NULL) OR ("profile_facts"."source" <> 'project' AND "profile_facts"."project_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"links" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_title_nonempty_check" CHECK (length(trim("projects"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "fit_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"strengths" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"unknowns" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"canonical_url_hash" text,
	"text_hash" text NOT NULL,
	"text" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_source_check" CHECK ("jobs"."source" IN ('url', 'paste', 'extension'))
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'saved' NOT NULL,
	"next_step" text DEFAULT 'Review your fit for this role' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_status_check" CHECK ("opportunities"."status" IN ('saved', 'reviewed', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_source_file_id_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_reviews" ADD CONSTRAINT "fit_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_reviews" ADD CONSTRAINT "fit_reviews_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_facts_user_status_created_idx" ON "profile_facts" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "profile_facts_source_file_idx" ON "profile_facts" USING btree ("source_file_id");--> statement-breakpoint
CREATE INDEX "profile_facts_project_idx" ON "profile_facts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "fit_reviews_user_opportunity_idx" ON "fit_reviews" USING btree ("user_id","opportunity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_user_url_unique" ON "jobs" USING btree ("user_id","canonical_url_hash") WHERE "jobs"."canonical_url_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_user_created_idx" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_job_unique" ON "opportunities" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "opportunities_user_created_idx" ON "opportunities" USING btree ("user_id","created_at");