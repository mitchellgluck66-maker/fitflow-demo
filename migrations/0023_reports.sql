-- Companion stage 3 (docs/plan-companion-stage3.md, items 2–3): the three switchable reports.
--   email_digests.is_test — a "Send test to me" row is archived but never counts as the period's scheduled send.
--   report_<kind>_enabled / report_<kind>_recipients — the per-report switch (default OFF: only a digest row that
--   was stored explicitly 'true' carries over; an absent row was "on by default" before and is OFF now until the
--   owner flips it) and the recipients the old digest rows named. Additive; the deployed code never reads them.
ALTER TABLE "email_digests" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_daily_enabled', "value", false FROM "settings" WHERE "key" = 'digest_enabled_todo' AND "value" = 'true'
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_weekly_enabled', "value", false FROM "settings" WHERE "key" = 'digest_enabled_weekly' AND "value" = 'true'
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_monthly_enabled', "value", false FROM "settings" WHERE "key" = 'digest_enabled_monthly' AND "value" = 'true'
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_daily_recipients', "value", false FROM "settings" WHERE "key" = 'digest_recipients_todo' AND coalesce("value", '') <> ''
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_weekly_recipients', "value", false FROM "settings" WHERE "key" = 'digest_recipients_weekly' AND coalesce("value", '') <> ''
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret")
SELECT 'report_monthly_recipients', "value", false FROM "settings" WHERE "key" = 'digest_recipients_monthly' AND coalesce("value", '') <> ''
ON CONFLICT ("key") DO NOTHING;
