-- F12 (2026-09-30 rebuild): the Stripe completeness sweep compares Stripe and the mirror PER DAY by Stripe's own
-- `created`. Additive (safe for the deployed code). Rows written before this migration are filled in the first
-- time the sweep re-lists their day; until then the sweep falls back to paid_at / failed_at.
ALTER TABLE "payments" ADD COLUMN "stripe_created_at" timestamp with time zone;