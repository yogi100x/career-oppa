CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"amount" integer NOT NULL,
	"bucket_split" jsonb NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result_type" text,
	"result_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_holds_amount_positive_check" CHECK ("credit_holds"."amount" > 0),
	CONSTRAINT "credit_holds_status_check" CHECK ("credit_holds"."status" IN ('reserved', 'settled', 'released', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"bucket" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_bucket_check" CHECK ("ledger_entries"."bucket" IN ('free', 'earned', 'purchased')),
	CONSTRAINT "ledger_entries_kind_check" CHECK ("ledger_entries"."kind" IN ('grant', 'expire', 'debit', 'purchase', 'refund', 'reward', 'adjust')),
	CONSTRAINT "ledger_entries_amount_nonzero_check" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_holds_user_status_expires_idx" ON "credit_holds" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_holds_idempotency_active_unique" ON "credit_holds" USING btree ("idempotency_key") WHERE "credit_holds"."status" IN ('reserved', 'settled');--> statement-breakpoint
CREATE INDEX "ledger_entries_user_created_idx" ON "ledger_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_unique" ON "ledger_entries" USING btree ("idempotency_key") WHERE "ledger_entries"."idempotency_key" IS NOT NULL;