CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"fact_ids" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"handoff_method" text,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"handed_off_at" timestamp with time zone,
	"marked_sent_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_status_check" CHECK ("outreach_drafts"."status" IN ('draft', 'handed_off', 'marked_sent')),
	CONSTRAINT "outreach_handoff_method_check" CHECK ("outreach_drafts"."handoff_method" IS NULL OR "outreach_drafts"."handoff_method" IN ('copy', 'mailto'))
);
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_user_opportunity_created_idx" ON "outreach_drafts" USING btree ("user_id","opportunity_id","created_at");--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_outreach_id_outreach_drafts_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_outreach_unique" ON "reminders" USING btree ("outreach_id") WHERE "reminders"."outreach_id" IS NOT NULL;