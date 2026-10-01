-- Analyst tuning item 5 (2026-09-30): the estimate shown before a turn, kept beside the measured cost so the next
-- estimate is calibrated from the last completed runs (median actual ÷ estimate per kind). Additive — safe for the
-- deployed code; NULL on turns from before this migration (they are skipped by the calibration).
ALTER TABLE "analyst_turns" ADD COLUMN "estimate_usd" double precision;
