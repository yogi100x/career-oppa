-- The counters are short lived and contain no user records; rollback removes them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'rate_limits'
      AND column_name = 'external_subject'
  ) THEN
    DELETE FROM rate_limits WHERE user_id IS NULL AND external_subject IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE rate_limits DROP CONSTRAINT IF EXISTS rate_limits_owner_check;
--> statement-breakpoint
DROP INDEX IF EXISTS rate_limits_external_subject_action_unique;
--> statement-breakpoint
ALTER TABLE rate_limits DROP COLUMN IF EXISTS external_subject;
--> statement-breakpoint
ALTER TABLE rate_limits ALTER COLUMN user_id SET NOT NULL;
