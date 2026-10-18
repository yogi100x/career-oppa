-- Reverses 0024 by hand if needed. The migrator never runs files in down/.
ALTER TABLE "users" DROP COLUMN IF EXISTS "cv_contact";
ALTER TABLE "users" DROP COLUMN IF EXISTS "cv_name";
