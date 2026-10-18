ALTER TABLE rate_limits ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE rate_limits ADD COLUMN IF NOT EXISTS external_subject text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rate_limits_external_subject_action_unique
  ON rate_limits USING btree (external_subject, action_key);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rate_limits_owner_check'
      AND conrelid = 'rate_limits'::regclass
  ) THEN
    ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_owner_check
      CHECK ((user_id IS NOT NULL AND external_subject IS NULL)
        OR (user_id IS NULL AND external_subject IS NOT NULL));
  END IF;
END $$;
