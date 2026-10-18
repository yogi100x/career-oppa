DROP INDEX IF EXISTS "files_user_kind_hash_unique";
ALTER TABLE "files" DROP COLUMN IF EXISTS "content_hash";
