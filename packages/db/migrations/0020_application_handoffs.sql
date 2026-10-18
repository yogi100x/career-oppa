CREATE TABLE "application_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"resume_id" uuid,
	"source" text NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_resume_id_resume_versions_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resume_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_handoffs_one_pending_idx" ON "application_handoffs" USING btree ("user_id","opportunity_id") WHERE "application_handoffs"."answered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "application_handoffs_user_pending_idx" ON "application_handoffs" USING btree ("user_id","answered_at","created_at");