# FitFlow — Next Steps (saved from the build conversation, 2026-09-30)

## 1. Full data audit (do next)
New Claude conversation, fitflow-demo folder connected, paste:

> Read docs/verification-brief.md in my fitflow-demo folder, then CLAUDE.md
> and docs/audit-2026-09-29.md. Using the Supabase connector (project
> wgddugwyfawzxuugjook), run the complete verification plan in the brief:
> freshness, independent SQL recompute of every metric across the stated
> ranges in CAD and USD, comparison against what the app's engine serves,
> integrity checks (currency, RLS, encrypted credentials, dupes/orphans),
> and give me the terminal commands to run on my Mac for the live
> Stripe/Meta/GHL source comparisons. Deliver a pass/fail sheet where every
> number is computed twice and traced to its source. This app cannot be
> wrong — trace every mismatch to the exact rows.

## 2. Security hygiene (credentials appeared in the build chat)
- Rotate provider keys: GHL (Private Integrations → rotate), Meta (Business
  Settings → System users → FitFlow → new token, ads_read, Never), Stripe
  (Developers → API keys → roll restricted key). Paste each in Setup → verify.
- Reset the Supabase database password (Project Settings → Database), then
  update DATABASE_URL in: .env.local, Vercel env, and the GitHub secret
  (`gh secret set DATABASE_URL`, session pooler, port 5432).
- Secrets live in: Vercel env, GitHub Actions secrets, Mac Keychain
  ("FitFlow backup passphrase", "FitFlow cron secret").

## 3. Still parked
- Resend key + sending domain (digests email instead of archive)
- Anthropic key (insight cards + Ask)
- Stripe webhook registration (README) → STRIPE_WEBHOOK_SECRET in Vercel
- Terminal × Linear redesign — approved concept in docs/design-concept.html

## 4. Durability package (after the audit passes) — Claude Code prompt

You are in ~/fitflow-demo — FitFlow. Read CLAUDE.md first. Durability
package — make external change detectable early and failures loud:

1. PIN + WATCH API VERSIONS: pin every provider explicitly (Meta Graph API
   version in one constant, Stripe-Version header, GHL Version headers —
   verify). Settings-backed deprecation table (provider, pinned version,
   sunset date — seed Meta's published sunset, mark unknowns clearly).
   Nightly dispatch step: warning incident 60 days before a sunset,
   critical at 14. Show pinned versions + sunsets in Setup sync health.
2. NIGHTLY SHAPE PROBE: one minimal read-only request per configured
   provider; shape fingerprint (sorted field paths + types, no values)
   diffed against stored; added/removed/type-changed fields → info
   incident (warning if a consumed field changed). Never log values.
   GHL probe GET-only.
3. CI + DEPENDENCIES: .github/workflows/ci.yml running npm ci + npm run
   check on push/PR (cache npm; mind the 2,000 Actions min/month).
   .github/dependabot.yml weekly npm, grouped minor/patch. README: how to
   enable branch protection (document, don't enable).
4. ALERT OUTWARD: with Resend configured, any new critical incident or
   dispatch_stuck emails the admin recipient once, deduped, max 1 per
   incident per 24h. Inert without the key.
Tests for fingerprint diffing, sunset thresholds, alert dedupe. npm run
check green, CLAUDE.md "Durability" section, commit. Don't touch
vercel.json or the GHL read-only guarantee.
