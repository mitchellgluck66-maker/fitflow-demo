-- 2026-09-30 (the F13 bug class): ad_spend.currency loses its 'USD' default. Every writer — Meta (the account's
-- currency), Google Ads (customer.currency_code / the CSV's column or the chosen currency) and manual weekly spend
-- (the currency chosen in the form) — now states it; a write without one FAILS instead of being silently labelled
-- USD. Safe for the deployed code: its writers already pass currency explicitly.
ALTER TABLE "ad_spend" ALTER COLUMN "currency" DROP DEFAULT;