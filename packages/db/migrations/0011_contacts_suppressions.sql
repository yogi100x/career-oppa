CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_name_nonempty_check" CHECK (length(trim("companies"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_contact_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"email" text,
	"email_status" text DEFAULT 'unknown' NOT NULL,
	"revealed_at" timestamp with time zone,
	"source" text DEFAULT 'getleads' NOT NULL,
	"source_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_email_status_check" CHECK ("contacts"."email_status" IN ('unknown', 'VALID', 'CATCH_ALL')),
	CONSTRAINT "contacts_source_check" CHECK ("contacts"."source" = 'getleads'),
	CONSTRAINT "contacts_reveal_consistency_check" CHECK (("contacts"."email" IS NULL AND "contacts"."revealed_at" IS NULL) OR ("contacts"."email" IS NOT NULL AND "contacts"."revealed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_reason_nonempty_check" CHECK (length(trim("suppressions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_normalized_name_unique" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_unique" ON "companies" USING btree ("domain") WHERE "companies"."domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_opportunity_provider_unique" ON "contacts" USING btree ("user_id","opportunity_id","provider_contact_id");--> statement-breakpoint
CREATE INDEX "contacts_user_opportunity_created_idx" ON "contacts" USING btree ("user_id","opportunity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_hash_unique" ON "suppressions" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "suppressions_created_at_idx" ON "suppressions" USING btree ("created_at");