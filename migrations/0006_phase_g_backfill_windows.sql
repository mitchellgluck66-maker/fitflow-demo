-- Phase G item 6: backfill windows decided at the Sept 1 meeting.
--   GHL / Stripe history from 2026-06-01 (was 2026-06-16).
--   Meta history from 2026-07-16 — the VSL campaign launch; earlier Meta rows
--   are noise. Rows already imported before either date are kept; syncs simply
--   never fetch earlier ranges again.
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at") VALUES ('backfill_from', '2026-06-01', false, now())
  ON CONFLICT ("key") DO UPDATE SET "value" = '2026-06-01', "updated_at" = now();--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at") VALUES ('meta_backfill_from', '2026-07-16', false, now())
  ON CONFLICT ("key") DO UPDATE SET "value" = '2026-07-16', "updated_at" = now();--> statement-breakpoint
-- A Meta backfill cursor left behind by an earlier (June-16-based) run would
-- otherwise resume from before the new window; clear it.
UPDATE "settings" SET "value" = '', "updated_at" = now() WHERE "key" = 'meta_backfill_cursor';
