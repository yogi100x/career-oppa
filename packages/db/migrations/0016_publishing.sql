CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"content" text NOT NULL,
	"fact_ids" jsonb NOT NULL,
	"destination" text DEFAULT 'copy' NOT NULL,
	"social_connection_id" uuid,
	"approved_content" text,
	"approved_destination" jsonb,
	"approved_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_post_id" text,
	"public_url" text,
	"first_attempt_at" timestamp with time zone,
	"attempt_at" timestamp with time zone,
	"attempt_id" uuid,
	"error_code" text,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "posts_provider_post_id_unique" UNIQUE("provider_post_id"),
	CONSTRAINT "post_status_check" CHECK ("posts"."status" IN ('draft', 'approved', 'publishing', 'published', 'failed', 'unknown', 'copy_ready'))
);
--> statement-breakpoint
CREATE TABLE "publishing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_post_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publishing_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_profile_id" text,
	"provider_account_id" text,
	"platform" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "social_connections_provider_profile_id_unique" UNIQUE("provider_profile_id"),
	CONSTRAINT "social_connections_provider_account_id_unique" UNIQUE("provider_account_id"),
	CONSTRAINT "social_connection_status_check" CHECK ("social_connections"."status" IN ('pending', 'connected', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_social_connection_id_social_connections_id_fk" FOREIGN KEY ("social_connection_id") REFERENCES "public"."social_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_user_created_idx" ON "posts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "publishing_events_post_idx" ON "publishing_events" USING btree ("provider_post_id");