-- Roll back 0027_telegram_links by removing its dependent codes before links.
DROP TABLE IF EXISTS "telegram_link_codes";
DROP TABLE IF EXISTS "telegram_links";
