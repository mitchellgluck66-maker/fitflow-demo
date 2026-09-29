-- M3 (2026-09-29 audit): payment_class gains an explicit 'excluded' value for
-- rows that are never cash — failed, pending and fully refunded charges,
-- refund rows and subscription plan rows — replacing null-as-meaning (466
-- rows in production). null now means only "not yet classified", which the
-- engine reports as a data-health warning.
--
-- Mirrors lib/stripe/classify.ts#isCashPayment exactly: a row is cash iff
-- kind ∈ {charge, invoice} AND status = 'succeeded' AND refunded < amount.
-- Cash rows still null are left for the classifier (it runs after every
-- Stripe sync, or: npm run reclassify:payments) because initial vs recurring
-- depends on each customer's history.
UPDATE "payments" SET "payment_class" = 'excluded', "updated_at" = now()
  WHERE "payment_class" IS NULL
    AND ("kind" NOT IN ('charge', 'invoice') OR "status" <> 'succeeded' OR "refunded_cents" >= "amount_cents");
