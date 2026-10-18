CREATE TABLE IF NOT EXISTS "telegram_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_telegram_user_unique" ON "telegram_links" USING btree ("telegram_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_links_chat_idx" ON "telegram_links" USING btree ("chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_link_codes_user_idx" ON "telegram_link_codes" USING btree ("user_id");
