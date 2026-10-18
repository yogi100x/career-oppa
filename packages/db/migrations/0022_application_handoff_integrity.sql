CREATE UNIQUE INDEX "opportunities_id_user_unique" ON "opportunities" USING btree ("id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "resume_versions_id_user_opportunity_unique" ON "resume_versions" USING btree ("id","user_id","opportunity_id");
--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_opportunity_owner_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunities"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_opportunity_owner_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunities"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_resume_owner_fk" FOREIGN KEY ("resume_id","user_id","opportunity_id") REFERENCES "public"."resume_versions"("id","user_id","opportunity_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_source_check" CHECK ("application_handoffs"."source" IN ('approved_pdf', 'employer_link'));
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_response_check" CHECK ("application_handoffs"."response" IS NULL OR "application_handoffs"."response" IN ('applied', 'not_yet'));
--> statement-breakpoint
ALTER TABLE "application_handoffs" ADD CONSTRAINT "application_handoffs_answer_pair_check" CHECK (("application_handoffs"."response" IS NULL AND "application_handoffs"."answered_at" IS NULL) OR ("application_handoffs"."response" IS NOT NULL AND "application_handoffs"."answered_at" IS NOT NULL));
