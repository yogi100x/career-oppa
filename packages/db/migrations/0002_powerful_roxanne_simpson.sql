CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"kind" text NOT NULL,
	"original_name" text,
	"content_type" text,
	"size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_kind_check" CHECK ("files"."kind" IN ('cv_upload', 'resume_pdf')),
	CONSTRAINT "files_size_nonnegative_check" CHECK ("files"."size" IS NULL OR "files"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limits_count_positive_check" CHECK ("rate_limits"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_r2_key_unique" ON "files" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "files_user_created_idx" ON "files" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_user_action_unique" ON "rate_limits" USING btree ("user_id","action_key");