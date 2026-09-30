-- F8 (2026-09-30 rebuild): the business timezone is DATA, not a code default.
-- The 2026-09-29 verification found no settings.timezone row: everything fell back to
-- BUSINESS_TIMEZONE / America/New_York (5,490 appointments stamped New York, CLI runs on New York day
-- boundaries). The business runs on America/Edmonton. An existing non-empty row is a human's choice and
-- is kept. Safe for the currently deployed code: it only reads this row (and gets Edmonton from now on).
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at")
VALUES ('timezone', 'America/Edmonton', false, now())
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now()
WHERE "settings"."value" IS NULL OR btrim("settings"."value") = '';
--> statement-breakpoint
-- The sync always stamps appointments.timezone; a silent America/New_York default is never used again.
ALTER TABLE "appointments" ALTER COLUMN "timezone" DROP DEFAULT;
