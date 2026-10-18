CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"idempotency_key" text NOT NULL,
	"hold_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "tasks_attempts_nonnegative_check" CHECK ("tasks"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_hold_id_credit_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_holds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_key_unique" ON "tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "tasks_user_status_created_idx" ON "tasks" USING btree ("user_id","status","created_at");