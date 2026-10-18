CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
	"type" text NOT NULL,
	"user_id" uuid,
	"payment_id" text,
	"refund_id" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_refund_id" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"user_id" uuid,
	"is_partial" boolean NOT NULL,
	"amount_minor" integer,
	"currency" text,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_amount_nonnegative_check" CHECK ("payment_refunds"."amount_minor" IS NULL OR "payment_refunds"."amount_minor" >= 0),
	CONSTRAINT "payment_refunds_status_check" CHECK ("payment_refunds"."status" IN ('pending_payment', 'applied', 'manual_review'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_payment_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"pack_id" text NOT NULL,
	"product_id" text NOT NULL,
	"credits" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_pack_id_check" CHECK ("payments"."pack_id" IN ('starter', 'job_hunt', 'full_season')),
	CONSTRAINT "payments_credits_positive_check" CHECK ("payments"."credits" > 0),
	CONSTRAINT "payments_amount_nonnegative_check" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('succeeded', 'refunded', 'manual_review'))
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_webhook_id_unique" ON "payment_events" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_provider_refund_id_unique" ON "payment_refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_provider_payment_id_idx" ON "payment_refunds" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_id_unique" ON "payments" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "payments_user_created_idx" ON "payments" USING btree ("user_id","created_at");