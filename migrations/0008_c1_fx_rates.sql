-- C1 (2026-09-29 audit): currency correctness. Amounts keep their original
-- currency; the metrics engine converts to the reporting currency at READ time.
CREATE TABLE "fx_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"from_ccy" text NOT NULL,
	"to_ccy" text NOT NULL,
	"rate" double precision NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pair_date_uidx" ON "fx_rates" USING btree ("date","from_ccy","to_ccy");--> statement-breakpoint
-- APPROXIMATE PLACEHOLDER, NOT OFFICIAL RATES: monthly USD→CAD for 2026, flat
-- 1.36 (source='seed'). Replace with Bank of Canada monthly averages in
-- Setup → Currency; CAD→USD is derived as the inverse, never stored.
INSERT INTO "fx_rates" ("id", "date", "from_ccy", "to_ccy", "rate", "source", "updated_at") VALUES
  ('seed-usd-cad-2026-01', '2026-01-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-02', '2026-02-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-03', '2026-03-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-04', '2026-04-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-05', '2026-05-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-06', '2026-06-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-07', '2026-07-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-08', '2026-08-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-09', '2026-09-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-10', '2026-10-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-11', '2026-11-01', 'USD', 'CAD', 1.36, 'seed', now()),
  ('seed-usd-cad-2026-12', '2026-12-01', 'USD', 'CAD', 1.36, 'seed', now())
  ON CONFLICT ("date", "from_ccy", "to_ccy") DO NOTHING;--> statement-breakpoint
-- Normalise stored codes (Stripe sends lower-case).
UPDATE "payments" SET "currency" = upper("currency") WHERE "currency" <> upper("currency");--> statement-breakpoint
UPDATE "ad_spend" SET "currency" = upper("currency") WHERE "currency" <> upper("currency");--> statement-breakpoint
-- Refund and subscription rows were hard-labelled USD at ingest regardless of
-- their real currency. A refund inherits its parent charge's currency; a
-- subscription its customer's latest charge's (the next Stripe sync then
-- writes Stripe's own value for both).
UPDATE "payments" AS r SET "currency" = c."currency"
  FROM "payments" AS c
  WHERE r."kind" = 'refund' AND c."stripe_id" = r."metadata"->>'charge' AND r."currency" <> c."currency";--> statement-breakpoint
UPDATE "payments" AS s SET "currency" = sub."currency"
  FROM (
    SELECT DISTINCT ON ("stripe_customer_id") "stripe_customer_id", "currency"
    FROM "payments"
    WHERE "kind" IN ('charge', 'invoice') AND "stripe_customer_id" IS NOT NULL
    ORDER BY "stripe_customer_id", "paid_at" DESC NULLS LAST
  ) AS sub
  WHERE s."kind" = 'subscription' AND s."stripe_customer_id" = sub."stripe_customer_id" AND s."currency" <> sub."currency";--> statement-breakpoint
-- Reporting currency (C1 + 1b): one business-wide value, default CAD. GHL
-- contract values are assumed CAD (the location currency) until confirmed.
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at") VALUES ('reporting_currency', 'CAD', false, now()) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "is_secret", "updated_at") VALUES ('contract_value_currency', 'CAD', false, now()) ON CONFLICT ("key") DO NOTHING;
