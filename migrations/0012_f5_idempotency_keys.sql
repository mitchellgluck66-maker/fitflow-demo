-- F5 (2026-09-30 rebuild): idempotency enforced by the DATABASE.
-- The 2026-09-29 verification found 3,051 exact duplicate stage_transitions: both 2026-09-01 backfill runs
-- wrote every row. Duplicates are removed first (keeping the earliest row of each natural key), then a unique
-- index makes a repeat impossible; the sync inserts with ON CONFLICT DO NOTHING.
-- Safe for the currently deployed code: it only INSERTs transitions; an exact duplicate insert (which only a
-- double run produces) now fails that one run instead of silently doubling history.

CREATE TABLE "sync_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Every table is deny-all to the PostgREST roles (C2, migration 0009); the app connects as the owner.
ALTER TABLE "sync_locks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DELETE FROM "stage_transitions" t
USING "stage_transitions" d
WHERE t."contact_id" = d."contact_id"
  AND coalesce(t."ghl_opportunity_id", '') = coalesce(d."ghl_opportunity_id", '')
  AND coalesce(t."from_stage_id", '') = coalesce(d."from_stage_id", '')
  AND coalesce(t."to_stage_id", '') = coalesce(d."to_stage_id", '')
  AND t."observed_at" = d."observed_at"
  AND (t."created_at", t."id") > (d."created_at", d."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transitions_natural_uidx" ON "stage_transitions" USING btree ("contact_id",coalesce("ghl_opportunity_id", ''),coalesce("from_stage_id", ''),coalesce("to_stage_id", ''),"observed_at");
--> statement-breakpoint
-- A digest was actually e-mailed twice for one period only under a double run. Such history rows keep their
-- evidence but are relabelled 'sent_duplicate' (the earliest stays 'sent') so the one-send rule can be enforced.
UPDATE "email_digests" e SET "status" = 'sent_duplicate'
WHERE e."status" = 'sent'
  AND EXISTS (
    SELECT 1 FROM "email_digests" f
    WHERE f."status" = 'sent' AND f."kind" = e."kind" AND f."period_start" = e."period_start" AND f."period_end" = e."period_end"
      AND (f."created_at", f."id") < (e."created_at", e."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "email_digests_sent_once_uidx" ON "email_digests" USING btree ("kind","period_start","period_end") WHERE "email_digests"."status" = 'sent';
