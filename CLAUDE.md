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
   `GET /opportunities/search` documents its filters in snake_case
   (`location_id`, `pipeline_id`) unlike every other endpoint — the client sends
   those; confirm against the first real response (runtime evidence wins).

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

## Phase A status (done 2026-08-26)

- Postgres via Drizzle: `DATABASE_URL` → Supabase (postgres-js); unset → embedded
  PGlite in `db/pglite/` (gitignored). `npm run db:migrate`, `npm run db:seed`.
- Read-only GHL: `lib/ghl/client.ts#ghlRequest` throws on any non-GET while
  `ENABLE_WRITEBACK` (literal `false` in `lib/ghl/config.ts`) is off.
  `npm run verify:readonly` proves it by grep; `tests/readonly.test.ts` by test.
- Sync: `lib/ghl/ingest.ts#runGhlSync({mode:'delta'|'backfill'})`; cron in
  `vercel.json` → `/api/cron/sync-ghl` (hourly on Pro, daily on Hobby; needs `CRON_SECRET`). Backfill from
  `settings.backfill_from` (2026-06-16) via Setup or `npm run backfill`.
- Stage roles: `lib/ghl/roles.ts` suggests; ≥0.8 confidence auto-applies,
  otherwise `unmapped` + `sync_incidents` row; humans override in /setup
  (`role_source='manual'`, never overwritten by sync).
- `/today` + `lib/ghl/{sync,mapping}.ts` are dormant (unlinked, gated).
- `npm run check` = typecheck + vitest + verify:readonly + build.

## Phase B status (done 2026-08-26)

- `lib/dates/`: presets → Sun–Sat weeks in the business tz; `previousPeriod`
  keeps week/month alignment, `samePeriodLastYear` shifts weeks by 364 days;
  `trailingWeeks(date, 8)` is the funnel-chip baseline. 18 tests (DST, month ends).
- `lib/metrics/`: pure engine (`index.ts`, 21 fixture tests), `load.ts` is the
  only DB touchpoint, `service.ts#getScorecard/getTodoBuckets` is the one call
  path for `/api/scorecard`, the Command Center, /funnel AND the emails.
  Funnel definitions live in the header comment of `lib/metrics/index.ts`.
- Nav: Command Center (/) · Funnel · Reports · Setup. `/metrics`, `/settings`,
  `/today` are dormant (routable, unlinked).
- Revenue/ROAS render "Awaiting Stripe" until a `payments` row with
  origin='stripe' exists — never a number.
- Manual weekly spend: `/setup#spend` → `ad_spend` rows `manual:{platform}:{weekStart}`;
  `computeSpend` drops manual rows for any platform+week that has an API row.
- Emails (`lib/email/`): daily_todo, weekly (last Sun–Sat week vs previous),
  monthly (last month). Skip when empty; idempotent per (kind, period); without
  `RESEND_API_KEY` the digest is stored (`email_digests.status='stored'`) and
  viewable on /reports. Recipients: settings `digest_recipients_{todo,weekly,monthly}`,
  default mitchellgluck66@gmail.com until changed on /reports. Crons fire at
  11 and 12 UTC and the route only runs when it is 7am in the business tz.

## Phase C status (done 2026-08-26 — built with NO keys; lights up when keys are pasted in /setup)

- Meta (`lib/meta/`): GET-only Graph API insights (level=ad, daily), rows
  `ad_spend` keyed `meta:{ad_id}:{date}`, origin='meta'. Delta = last 3 days;
  backfill from `backfill_from`. Setup card verifies with one `/act_{id}` call.
- Spend precedence (`lib/metrics#expandSpend`): API rows own their platform+date;
  a manual weekly row is spread over its 7 days and used only for uncovered
  dates. Tested in `tests/money.test.ts`.
- Stripe (`lib/stripe/`): restricted key (rk_…) GET-only; charges/invoices,
  subscriptions (monthly-normalised), refunds, failed → `payments` keyed by
  stripe id, origin='stripe'. `/api/stripe/webhook` verifies the signature
  (`stripe_webhook_secret`). Reconcile = last 7 days.
- Matching (`lib/stripe/matching.ts` over `lib/metrics#matchPayments`): email
  then phone via the normalisers in `lib/ghl/transitions.ts`; `match_source`
  'manual' (Setup → Sync health → Unmatched payments) is never overwritten.
- Tabs: Ads (KPIs, spend-vs-revenue, campaign table with platform-reported vs
  FitFlow-tracked columns; manual weekly spend now lives here) and Revenue
  (whole-tab "Connect Stripe" state until rows exist). Nav: Command Center ·
  Funnel · Ads · Revenue · Reports · Setup.
- Crons (Vercel Hobby = 2 jobs, each once daily): `vercel.json` has only
  `/api/cron/sync-ghl` (12:00 UTC) and `/api/cron/dispatch` (13:00 UTC).
  Dispatch runs GHL delta → Meta → Stripe → Google → insights → narratives →
  daily/weekly/monthly digests. Digest guards are "at/after 7am local" +
  Monday / 1st, and every step is idempotent, so a once-daily 9am-ET run
  still sends each digest exactly once. **Pro plan:** set sync-ghl to
  `0 * * * *`, dispatch to `0 11,12 * * *` (lands on 7am ET across DST) and
  optionally add per-job lines (routes still exist under `app/api/cron/*`).
  Do not edit vercel.json casually — it is Hobby-constrained on purpose.
- Read-only GHL guarantee untouched: `npm run verify:readonly` still passes.

## Phase D status (done 2026-08-26 — intelligence + design; keys paste in later)

- Outcome tokens in `app/globals.css`: `--positive*` (muted emerald) and
  `--negative*` (muted crimson), both themes. Enrolled/converted = positive,
  drop-off/no-show/failed = negative; purple stays the structural accent.
- Command Center = 5 KPI tiles + compact `FunnelStrip` (links to /funnel) +
  trend + `InsightsCard`. /funnel owns the full funnel, per-source table,
  small multiples and people drawer. They are deliberately different.
- Clients: `/clients` (search/filter/paginate) and `/clients/[id]` (identity,
  stage + time-in-stage, unified timeline of transitions/appointments/payments,
  "Open in GoHighLevel"). Every person anywhere links there. ⌘K global search.
- Anthropic (`lib/anthropic/`): key in settings (masked); prompts in
  `prompts.ts`; `lib/metrics/insights.ts#buildInsightInput` is the pure,
  tested JSON snapshot handed to the model. Outputs cached in `ai_reports` by
  input hash: kind `insight` (≤3 findings, deep links), `weekly_narrative` /
  `monthly_narrative` (rendered in the scorecard email only when present).
  Remap suggester: `POST /api/anthropic/suggest-role` — suggestion only,
  applied by a human in Setup → Sync health.
- Sync health (Setup): last run per source, rejected rows, unmapped stages
  (assign / Claude-suggest → Apply), unmatched payments picker, incident list
  with resolve. `lib/sentry.ts` posts errors when `SENTRY_DSN` is set.
- Google Ads (`lib/googleads/`): full OAuth + GAQL client behind a "pending"
  Setup card; CSV export upload on /ads writes `ad_spend` origin='google_csv'
  (API-grade for its dates, replacing manual).
- Reports: archive of every digest (sent/stored/skipped/failed) + per-digest
  enabled toggles and recipients.
- Dispatch order: GHL → Meta → Stripe → Google → insights → narratives →
  digests. `vercel.json` unchanged (Hobby: 2 crons).

## Working agreements

- Design system: existing tokens in `app/globals.css` (Linear-style, deep purple accent,
  Inter, dark/light). Reuse `components/` primitives; no new visual languages.
- Typecheck + build + Vitest before calling anything done. Playwright screenshots for
  UI changes (harness in repo history).
- Commit small, descriptive; never commit secrets or `db/*.db`.
- When GHL's real response shape differs from the docs (some fields are undocumented),
  prefer runtime evidence: log the shape once, adapt, note it here.
