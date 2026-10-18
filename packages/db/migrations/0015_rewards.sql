CREATE TABLE "reward_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"disclosure_confirmed" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" uuid,
	"reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "reward_submissions_status_check" CHECK ("reward_submissions"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "reward_submissions_disclosure_check" CHECK ("reward_submissions"."disclosure_confirmed" = true),
	CONSTRAINT "reward_submissions_reason_check" CHECK ("reward_submissions"."status" <> 'rejected' OR length(trim(coalesce("reward_submissions"."reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "reward_submissions" ADD CONSTRAINT "reward_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_submissions" ADD CONSTRAINT "reward_submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_submissions_url_hash_unique" ON "reward_submissions" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "reward_submissions_user_created_idx" ON "reward_submissions" USING btree ("user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "reward_submissions_status_created_idx" ON "reward_submissions" USING btree ("status","submitted_at");