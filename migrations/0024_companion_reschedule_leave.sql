-- Companion stage 5 (docs/plan-companion-stage5.md, item 1): a Reschedule never cancels the appointment by default.
-- Stage 2 defaulted companion_reschedule_appointment to 'cancelled'; on 2026-10-30 that cancelled Sindhu's event and
-- GoHighLevel emailed her a cancellation for an appointment she still had. The code default is now 'leave'.
--   no stored row      → the old default was in force and was never edited → the explicit 'leave' row is written;
--   stored 'cancelled' → a human chose it in Setup → kept, and named in a NOTICE (Setup labels the option as one that
--                        may email the client);
--   stored 'leave'     → nothing to do.
-- Additive; the deployed code reads the row the same way.
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at")
VALUES ('companion_reschedule_appointment', 'leave', false, now())
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE v text;
BEGIN
  SELECT "value" INTO v FROM "settings" WHERE "key" = 'companion_reschedule_appointment';
  IF v = 'cancelled' THEN
    RAISE NOTICE 'companion_reschedule_appointment is ''cancelled'' (set by the owner in Setup) — kept; a Reschedule still cancels the appointment and GoHighLevel may email the client';
  END IF;
END $$;
