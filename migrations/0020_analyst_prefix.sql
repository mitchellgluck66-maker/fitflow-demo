-- Analyst Oct 4 item 5 (2026-10-06): the estimate prices the stable prefix as a cache HIT (warm — a turn with the
-- same brief finished inside the cache TTL) or a cache WRITE (cold), and calibration buckets by (kind, prefix).
-- Each turn keeps the prefix state it was priced under and the brief hash its request carried. Additive — safe for
-- the deployed code; NULL on turns from before this migration (skipped by the calibration and the warm check).
ALTER TABLE "analyst_turns" ADD COLUMN "prefix" text;--> statement-breakpoint
ALTER TABLE "analyst_turns" ADD COLUMN "brief_hash" text;
