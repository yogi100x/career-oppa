CREATE TABLE "practice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feedback" jsonb,
	"status" text DEFAULT 'questions_ready' NOT NULL,
	"answer_hash" text,
	"feedback_attempt" uuid,
	"question_prompt_version" text NOT NULL,
	"feedback_prompt_version" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_status_check" CHECK ("practice_sessions"."status" IN ('questions_ready', 'generating_feedback', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_user_role_created_idx" ON "practice_sessions" USING btree ("user_id","opportunity_id","created_at");