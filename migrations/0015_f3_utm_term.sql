-- F3 (2026-09-30 rebuild): utm_term, parsed from the landing URL like the other utm_* fields. Additive — safe for the
-- deployed code. Existing contacts are filled by the dispatch's first-run attribution job (lib/attribution/utm.ts),
-- not here: URL decoding (+ and %xx, malformed escapes) is code, not SQL.
ALTER TABLE "contacts" ADD COLUMN "utm_term" text;