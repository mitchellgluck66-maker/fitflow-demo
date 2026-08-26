# FitFlow — Project Brief for Claude Code

FitFlow is a **read-only growth-intelligence dashboard** for The Fit Physician (fitness
coaching business). It observes GoHighLevel, Meta Ads, Google Ads and Stripe, computes
funnel/CAC economics, sends scheduled email reports, and uses the Anthropic API for
analysis. The full plan lives in `docs/FitFlow-v2-Master-Plan.pdf` — read it before
large changes. This file is the standing contract.

## Non-negotiable rules

1. **NEVER write to GoHighLevel.** Miranda's pipeline is the source of truth; this app
   only reads. The old write-back engine in `lib/ghl/sync.ts` + `lib/ghl/mapping.ts` is
   dormant behind `ENABLE_WRITEBACK` (hard-off). Do not re-enable it, do not add new
   GHL writes. If a task seems to need one, stop and ask Mitchell.
2. **Weeks are Sunday–Saturday** (Meta Ads convention), hard-coded in all weekly
   bucketing. Business timezone from settings governs day boundaries — never UTC.
3. **The metrics engine (`lib/metrics/`) is pure functions** over (dateRange, pipelineId).
   Dashboard, emails and AI all call the same functions. Every formula has a Vitest
   test against hand-computed fixtures. If dashboard and email could ever disagree,
   the design is wrong.
4. **Idempotent ingestion**: every external row keyed by its external id; re-running any
   sync must be safe. Every row carries `source`, `synced_at`, `backfilled`.
5. **Credentials** live in the settings table (entered in /setup, verified on save,
   masked in responses) with env-var fallback. Never echo a secret to the client,
   never log one, never commit one.
6. **Sample data is labelled.** Any fabricated row has `origin='demo'`; analytics pages
   show the sample-data banner while any exists. Never present generated numbers as
   real (this bit us once already).
7. Validate every external API response at the boundary with Zod. GHL quirks that cost
   us before: `Version` header is `v3` for /calendars/* but `2021-07-28` elsewhere;
   `noshow` one word; `cancelled` double-L; contact-PUT `tags` REPLACES the whole set
   (use the dedicated tag endpoints — moot now that we're read-only, but don't regress);
   rate limit 100 req/10s — bulk-fetch opportunities, dedupe contact fetches.

## Architecture (target)

External APIs → ingest crons → Supabase Postgres → pure metrics engine → UI + emails.
- Hosting: Vercel (app + crons) + Supabase Postgres. Migrating from SQLite/Drizzle —
  keep Drizzle, swap driver to postgres.
- Sync cadence: GHL hourly delta; ad spend 4×/day; Stripe webhook + nightly reconcile;
  nightly 11pm snapshot/todo/AI job; emails 7am (daily), Mon 7am (weekly), 1st (monthly)
  via Resend.
- Stages are DYNAMIC: read from GHL each sync into `pipelines`/`stages`, mapped to
  semantic roles (applied, consult_booked, consult_noshow, roadmap_booked,
  roadmap_showed, enrolled, other) with manual-override UI. Unmapped stages surface in
  sync-health, with a Claude-suggested mapping — applied only on human approval.
- `stage_transitions` built by diffing consecutive syncs → powers time-in-stage and
  the Day-1/Day-3 to-do buckets.
- Identity: email/phone joins ad-click → GHL contact → Stripe payment.
- Sentry on errors AND silences (zero-lead sync, spend gap) → `sync_incidents`.

## Product spec highlights

- Nav: Command Center · Funnel · Ads · Revenue · Reports · Setup.
- One global date picker per page (presets incl. This/Last week Sun–Sat with resolved
  dates shown) + comparison dropdown (prev period / last year / off). Delta chips
  everywhere; cost metrics invert green/red; tooltips name exact comparison dates.
- Command Center above the fold: 5 KPI tiles (Revenue collected, Enrollments, Cost per
  client, ROAS, Consults booked) → full-width funnel → trend + AI insight card.
- Funnel = horizontal proportional bars with ghost drop-off segments and stage→stage %
  chips colored vs trailing 8-week average. NEVER a tapered funnel shape. Bar click →
  drawer with the actual people.
- Emails follow scorecard rules: one timeframe per digest; skip sending when empty.
- Daily to-do email buckets: Day-1 and Day-3 × {applied-no-booking, consult no-show,
  roadmap no-show}, names listed plainly. Recipients: Miranda + Jake.

## Build phases (work in order, each shippable)

A. Foundation: Supabase migration, read-only GHL, dynamic stage model, hourly sync +
   transition history, June-16 backfill, Vercel deploy, strip marking UI.
B. Jake's core: date/comparison engine, tested metrics engine, Command Center + Funnel
   tab, manual weekly spend entry (bridges CAC), daily to-do + Monday weekly emails.
C. Money rails: Meta spend sync, Stripe + payment matching, Ads + Revenue tabs.
D. Intelligence: Anthropic insights + weekly narrative, Sentry + sync-health + remap
   suggester, Google Ads OAuth (CSV fallback until granted), Reports archive.

## Working agreements

- Design system: existing tokens in `app/globals.css` (Linear-style, deep purple accent,
  Inter, dark/light). Reuse `components/` primitives; no new visual languages.
- Typecheck + build + Vitest before calling anything done. Playwright screenshots for
  UI changes (harness in repo history).
- Commit small, descriptive; never commit secrets or `db/*.db`.
- When GHL's real response shape differs from the docs (some fields are undocumented),
  prefer runtime evidence: log the shape once, adapt, note it here.
