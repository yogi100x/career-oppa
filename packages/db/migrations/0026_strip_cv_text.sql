-- Removes stored CV text (phone numbers, addresses) from earlier CV tasks and
-- keeps only its length. Safe to run more than once. Not reversible by design:
-- the original file is still in private storage if a retry needs it.
UPDATE "tasks"
SET "output" = ("output" - 'text') || jsonb_build_object('textLength', length("output"->>'text'))
WHERE "kind" = 'cv_extract' AND "output" ? 'text';
