CREATE TABLE "coach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"opportunity_id" uuid,
	"request_key" text,
	"reply_to_id" uuid,
	"status" text DEFAULT 'completed' NOT NULL,
	"prompt_version" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_messages_role_check" CHECK ("coach_messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "coach_messages_status_check" CHECK ("coach_messages"."status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "coach_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" text DEFAULT 'change_status' NOT NULL,
	"data" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_messages_user_request_unique" ON "coach_messages" USING btree ("user_id","request_key") WHERE "coach_messages"."request_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_messages_reply_unique" ON "coach_messages" USING btree ("reply_to_id") WHERE "coach_messages"."reply_to_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "coach_messages_user_created_idx" ON "coach_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "coach_proposals_user_created_idx" ON "coach_proposals" USING btree ("user_id","created_at");