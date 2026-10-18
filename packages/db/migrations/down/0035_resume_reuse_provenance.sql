-- Preserve the source for an older application before removing the new field.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'resume_versions'
      AND column_name = 'reused_from_id'
  ) THEN
    UPDATE resume_versions
      SET restored_from_id = coalesce(restored_from_id, reused_from_id)
      WHERE reused_from_id IS NOT NULL;
    UPDATE events SET type = 'resume.restored', data = data - 'reusedFromId'
      WHERE type = 'resume.reused';
    ALTER TABLE resume_versions DROP COLUMN reused_from_id;
  END IF;
END $$;
