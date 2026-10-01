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
   never log one, never commit one. Since 2026-09-29 (H4) secret rows are stored
   AES-256-GCM encrypted (`enc:v1:…`) with env `CREDENTIALS_KEY`; ONLY
   `lib/settings#setSetting`/`getSetting` seal/open them (server-side, at call
   time). Production/preview without a valid key FAILS CLOSED (credentials read
   as absent, saves 503 with the Setup message). Never read `settings.value`
   for a secret any other way.
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
   The same endpoint returns pagination meta numbers as STRINGS
   (`meta.nextPage: "2"`) despite the docs — the 2026-09-01 first real import
   parsed 0 opportunities because of it. Every numeric field in
   `lib/ghl/schemas.ts` is therefore coercive (`ghlNumber`: number or numeric
   string); put any new numeric field on that helper.
8. **Metric definitions (Phase G, Sept 1 CEO meeting) — never present a computed
   number whose inputs are missing; show the data-health warning instead.**
   - *Currency (C1, 2026-09-29 audit — NON-NEGOTIABLE)*: the business reports in
     ONE currency, **CAD by default**, held in `settings.reporting_currency`
     (CAD | USD, one business-wide value — dashboard, digests and the AI context
     all follow it; not per-browser). Stored amounts are NEVER rewritten: every
     `payments` / `ad_spend` row keeps the currency it was charged in (the
     Meta ad account act_204679322688936 bills **CAD** — corrected 2026-09-30 (F13);
     every Meta run reads the account currency and fails closed without it;
     Stripe is ~63% CAD) and GHL contract values are in
     `settings.contract_value_currency` (CAD). The engine converts at READ time
     (`lib/metrics#inReportingCurrency`) at each row's own date from `fx_rates`
     (USD→CAD rows only, effective from their date; CAD→USD is the inverse —
     `lib/money#rateFor`). A converted row is labelled with the reporting
     currency, so converting twice is identity. Money is summed only through
     `lib/money#CentsTally` / `sumCents`, which THROW on a mismatched currency;
     a missing rate throws `FxRateMissingError` — never a silent 1:1. Every
     rendered amount carries its code (`formatCents(cents, currency)` →
     "$1,605 CAD"; the currency argument is required, and `KpiDeltaTile`
     `deltaKind="cents"` requires `currency`). Footers read "displayed in CAD ·
     USD converted at 1.4188 (Bank of Canada, Sep 29)" (`lib/money#fxNote` —
     names the rate's source and date). Rates come from the **Bank of Canada
     Valet FXUSDCAD feed** (`lib/fx/boc.ts`, dispatch step `fx`, 2026-09-30 —
     supersedes "no external FX feed"): it backfills every missing business
     day since the earliest money row, then runs daily; a MANUAL rate (Setup →
     Currency) for a date always wins and is never overwritten; `seed`
     placeholders are deleted once BoC covers their dates; newest rate older
     than the previous business day → one `fx_stale` warning incident.
     `npm run smoke:fx` compares live BoC with the stored rate. Rows in any
     other currency are dropped by the loader and counted
     (`money.unsupportedRows`), never summed. **Every spend writer takes its
     currency from the source or the UI and fails closed** — `ad_spend.currency`
     has NO default (migration 0016).
   - *Payment classes* (`payments.payment_class`, `lib/stripe/classify.ts`): a
     Stripe customer's FIRST successful, not-fully-refunded charge is `initial`
     (new-client cash) whatever the rail (a subscription-only client's first
     invoice is still initial); every later kept charge — subscription invoices
     included — is `recurring`; failed / pending / fully refunded / refund rows /
     plan rows are never cash and get the explicit class `excluded` (M3; `null`
     now means only "not yet classified" — a data-health warning — and
     `excludedReasonOf` names why a row is excluded). Customers group by Stripe
     id, then normalised email, then the row alone. Recomputed after every
     Stripe sync, webhook and demo seed; `npm run reclassify:payments`
     backfills. The Revenue footer reconciles to Stripe: "N payments excluded
     (…)", listed = initial + recurring + unclassified + excluded, and charged −
     refunded = collected.
   - *Attribution classes* (`contacts.attribution_class`, `lib/attribution/`):
     `paid` when the first touch carries an fbclid/gclid (field or landing-URL
     param) or utm_source → source → utm_medium → session source contains a whole
     token in facebook/fb/meta/instagram/google/paid/cpc/ppc without also saying
     "organic"; else `organic`. `attribution_reason` names the deciding signal;
     `attribution_class_source='manual'` (client profile override) is never
     overwritten by sync. `npm run reclassify:attribution` backfills.
   - *Marketing math uses ONLY initial cash and ONLY paid contacts where it says
     paid.* ROAS = paid-attributed initial cash (net of refunds, failed excluded)
     ÷ spend. **Paid CAC** = spend ÷ enrollments whose contact is `paid`.
     **Blended CAC** = spend ÷ ALL enrollments (organic included). **LTV:CAC** =
     Σ GHL opportunity value of the period's new clients ÷ spend (= avg contract
     value ÷ Blended CAC); withheld, with the clients listed, while any new client
     has no contract value. Cost per roadmap = spend ÷ roadmap_booked reached.
     Organic, unclassified and unmatched never leak into the paid figures — they
     surface as data-health counts (`MarketingMetrics`, `DataHealthNotice`).
   - *Funnel modes*: "In period" = events inside the dates (default everywhere);
     "By cohort" = everyone who applied inside the dates and every stage they
     have reached since, no time cutoff. Chips are recomputed per mode against
     the same-mode trailing-8-week baseline.
   - *History-dependent metrics (maturing data)*: live stage-history observation
     began 2026-09-01; before that GHL kept only each contact's last stage
     change. Consults booked, roadmaps booked, cost per lead / consult /
     roadmap and every stage→stage conversion are therefore under/over-counted
     for ranges touching earlier dates. Enrollments, initial cash, Paid /
     Blended CAC, ROAS, LTV:CAC, spend and show rates do NOT depend on that
     history and never carry the caveat. `lib/metrics/maturity.ts` owns the
     rule and the one wording; settings `history_complete_since` (2026-09-01)
     and `disclaimer_sunset` (2026-10-15, Setup → Data caveats) make it
     self-expiring — after the sunset nothing renders and the AI
     `dataCaveats` array is empty, no redeploy.
   - *Roles* consult_noshow / roadmap_noshow are the no-show stages (red treatment;
     a contact who entered one exactly 1 / 3 days ago joins the daily to-do
     no-show bucket alongside appointment no-shows). consult_rescheduled /
     roadmap_rescheduled are holding states whose
     occupants appear in the daily to-do "awaiting rebook" bucket every day until
     they leave; previous_lead is a parked row outside the stage chain, and a
     contact whose first observed stage was previous_lead never enters the stages.

9. **Every page and API route requires a session** (`proxy.ts`, Next 16's
   request interceptor; policy in `lib/auth/policy.ts`). Exempt, each with its
   own guard: `/login` (+ `/api/auth/*`), Next static assets and `/public`
   files, `/api/health`, `/api/cron/*` (CRON_SECRET), `/api/stripe/webhook`
   (signature). `APP_PASSWORD` + `AUTH_SECRET` are REQUIRED in production and
   preview — missing either fails CLOSED (503, no data). Local dev with both
   unset skips auth. Never add an exemption without its own guard; never put
   a secret in a cookie (the token is only an HMAC-signed timestamp pair).

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

- Nav: Command Center · Scorecard · Funnel · Ads · Revenue · Reports · Setup.
- One global date picker per page (presets incl. This/Last week Sun–Sat with resolved
  dates shown) + comparison dropdown (prev period / last year / off). Delta chips
  everywhere; cost metrics invert green/red; tooltips name exact comparison dates.
  On a week/month preset the picker grows ◀ ▶ (and ← → with focus) that step one
  whole Sun–Sat week / calendar month; ▶ stops at the current period.
- Every KPI tile is clickable: a trend popover of that metric (daily 30d for
  volume/cash, weekly 12w for rates/CAC) with the prior span faint.
- Command Center above the fold: KPI row 1 (Initial cash collected, Enrollments,
  Paid CAC, Blended CAC, ROAS) + row 2 (LTV:CAC, Consults booked, Cost per roadmap
  booked) → data-health notice → funnel strip → trend + AI insight card + Ask card.
- Funnel = horizontal proportional bars with ghost drop-off segments and stage→stage %
  chips colored vs trailing 8-week average. NEVER a tapered funnel shape. Bar click →
  drawer with the actual people. "By cohort" is the DEFAULT mode (`?mode=period`
  for the secondary "In period"); a caption under the funnel says what each mode
  counts, and the Command Center strip shows cohort numbers.
- Emails follow scorecard rules: one timeframe per digest; skip sending when empty.
- Daily to-do email buckets: Day-1 and Day-3 × {applied-no-booking, consult no-show,
  roadmap no-show} plus the persistent "awaiting rebook" bucket (everyone in a
  rescheduled role, every day until they rebook), names listed plainly.
  Recipients: Miranda + Jake.

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
  `settings.backfill_from` via Setup or `npm run backfill`. Since 2026-09-17 a sync
  is a RESUMABLE CYCLE (see Phase K): each run does what fits its time budget
  and persists a page cursor in `settings.ghl_sync_cursor`.
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
  (`stripe_webhook_secret`). Reconcile = last 7 days. Webhook registration:
  Stripe Dashboard → Developers → Webhooks → Add endpoint
  `https://<app-url>/api/stripe/webhook`, events charge.succeeded,
  charge.refunded, charge.failed, invoice.payment_succeeded,
  invoice.payment_failed; signing secret → Vercel `STRIPE_WEBHOOK_SECRET`,
  redeploy (see README).
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
  daily/weekly/monthly digests. Digest guards are "at/after 6am local"
  (`lib/email/cron#inSendWindow`; was 7am until the M1 fix) + Monday / 1st,
  and every step is idempotent, so a once-daily run still sends each digest
  exactly once. **Pro plan:** set sync-ghl to
  `0 * * * *`, dispatch to `0 11,12 * * *` (lands on 7am ET across DST) and
  optionally add per-job lines (routes still exist under `app/api/cron/*`).
  **Superseded 2026-09-30: Vercel Pro.** vercel.json runs sync-ghl hourly at
  :07 and dispatch hourly at :37 (primary); the GitHub heartbeat is a 6-hourly
  fallback. See "Ingestion v2 — Wave 1".
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

## Phase E status (done 2026-08-27 — polish + demo)

- `RadialRing` (components/RadialRing.tsx): rates only (0–100% frame), never
  counts or currency. Used for consult/roadmap show rates on /funnel and the
  applied→enrolled share on the Command Center strip.
- Deep filtering: one `FilterBar` + `useTableState` (URL query string, per-
  table prefix) on the clients index, campaign, payments and per-source
  tables — combinable chips, instant search, sortable headers. Filtered
  views are shareable links.
- Loading = section skeletons (`components/Skeleton.tsx`), never full-page
  spinners. Empty states audited in both themes. `.focus-ring` /
  `.row-clickable` utilities in globals.css.
- Screenshots: `npm run screenshots` (Playwright, Chromium) walks every tab in
  both themes → `docs/screens/{light,dark}/*.png`. Re-run after UI changes and
  commit the shots.
- Demo mode: `npm run db:seed:demo` (rich June-16→today story, ALL rows
  origin='demo', pre-generated insight cards + narrative marked demo, digest
  history) and `npm run db:wipe:demo`. Works on PGlite and DATABASE_URL. The
  sample-data banner shows whenever any demo row exists.

## Production hardening (2026-09-01 — first real GHL/Meta/Stripe run)

The first import against Jake's real accounts surfaced five issues; all fixed:

- **GHL numbers arrive as strings** (`meta.nextPage: "2"` broke pagination →
  0 contacts imported). Every numeric field in `lib/ghl/schemas.ts` uses the
  coercive `ghlNumber` helper — see rule 7.
- **Meta 500s on long insight windows.** All Meta windows are fetched in
  sequential ≤7-day chunks, 2 attempts each with backoff; a backfill records
  `settings.meta_backfill_cursor` per completed chunk and resumes there on
  re-run (`lib/meta/ingest.ts#chunkWindows`).
- **Stale runs**: a killed serverless function left sync_runs at 'running'
  forever. Every sync start sweeps 'running' rows older than 10 min to
  failed / `timed out (stale)` (`lib/staleRuns.ts`); sync-health presents
  not-yet-swept ones the same way.
- **Followed pipelines**: `pipelines.is_tracked` = "followed", default FALSE
  (migration 0002 unfollowed existing GHL rows). Syncs mirror EVERY pipeline
  via one location-wide opportunity search (keeps history), but only followed
  ones drive dashboards, metrics, digests and unmapped-stage warnings
  (`lib/metrics/load.ts` scopes by it). A contact's position prefers a
  followed-pipeline opportunity. Setup has a followed selector; `{ Off }...`
  pipelines (Jake's retirees, `lib/ghl/followed.ts#isOffPipeline`) sort last
  and are never suggested. After deploying, a human must follow at least one
  pipeline in Setup or every dashboard stays deliberately empty.
- **Payment re-match**: a GHL sync that upserts contacts immediately re-runs
  Stripe payment matching (first run matched 0/324 because contacts arrived
  after payments). Manual matches never overwritten.
- **Dates against raw SQL (2026-09-30, stripe_completeness's first scheduled run
  failed with 22007).** A JS `Date` compared with a raw sql`` expression (e.g.
  `coalesce(stripe_created_at, paid_at, failed_at)`) has no column to encode it;
  drizzle's postgres-js driver passes it through and postgres-js writes
  `Date.toString()`, which Postgres rejects. PGlite serializes Dates itself, so
  the tests never saw it. **Every such bound goes through `lib/sqlTime#tsParam`
  (ISO + `::timestamptz`) or `isoDayParam` for a YYYY-MM-DD value.** A typed
  timestamp column encodes its own Dates and needs neither.
  `tests/sql-date-params.test.ts` replays the postgres-js wire rule on real
  Postgres and fails the build on the old shape.

## Setup page layout (2026-09-01 — condensed for real-data scale)

Every Setup section is an `AccordionCard` (`components/AccordionCard.tsx`):
header = section name + live summary ("2 followed of 15", "Last sync 12 min
ago", "3 open"). Default open ONLY while a section needs attention —
unverified credential, unmapped stages in followed pipelines, open incidents,
or real pipelines with none followed. No persistence: the default recomputes
from live data each load until the user toggles (deliberate — default logic
over stored state). Incidents have their own section
(`components/setup/IncidentLog.tsx`): consecutive identical errors collapse
into ×N rows with first/last timestamps (`incidentGrouping.ts`, pure +
tested), 5 most recent by default, "Show all" paginates 25/page, resolved
rows behind a toggle, "Resolve all" per group via `PATCH /api/incidents
{ids}`. Pipelines: followed pinned on top expanded with stage mapping (only
followed pipelines ever render mapping UI), unfollowed as one-line rows,
"{ Off }" retirees and GHL-archived under a collapsed Archived group.

## Phase G status (done 2026-09-17 — the CEO's September metric changes, Sept 1 meeting)

Shipped in order, one commit each, `npm run check` green between items
(26 test files / 243 tests). Migrations 0003–0007; run `npm run db:migrate`
then `npm run reclassify` (payments + attribution) once on production.

1. **Payment classes** — see rule 8. `computeRevenue` splits initial / recurring /
   unclassified (unclassified succeeded cash = warning, never bucketed). Fully
   refunded charges now net to zero (they used to subtract twice). Revenue tab:
   Initial · Recurring · Subscriptions (MRR) · Failed · Refunds, class column +
   filter. Command Center tile = "Initial cash collected".
2. **Attribution** — see rule 8. Client profile "Attribution" card shows class,
   reason, click ids, session source, landing URL and an Automatic / paid /
   organic override (`PATCH /api/clients/[id]`, FitFlow-local). Clients index
   has an attribution facet. GHL schema now reads `fbclid`/`gclid`/`url` from
   `attributionSource` / `attributions[]`.
3. **Marketing engine** — `lib/metrics#computeMarketing` (10 fixture tests in
   `tests/marketing.test.ts`), surfaced on the Command Center, Ads tiles, the
   weekly/monthly digest (two stat rows + a CAC explanation line) and the
   insight JSON. `AdsKpis` gained cost per roadmap + both CACs.
4. **Funnel pipeline + roles** — hard-default followed pipeline
   `UR5P3vNTm9VPuYZFrb6c` "[new] Application Pipeline"
   (`lib/ghl/followed.ts#DEFAULT_FOLLOWED_PIPELINE_ID`; migration 0005
   unfollowed every other real pipeline; syncs follow it on first sight only —
   a human's toggle is never overwritten). New roles consult_rescheduled,
   roadmap_rescheduled, previous_lead with aliases; the suggester never maps a
   "rescheduled/rebook" name to a plain booking (it proposes the rescheduled
   role below threshold) and vice versa. `TodoBuckets.awaitingRebook` (dated
   from the latest entry into the role, `daysWaiting`) is in the daily email;
   `Funnel.previousLeads` is the dashed row on /funnel + a chip on the strip.
5. **Cohort mode** — `cohortMembership`, `computeFunnel(input, range, mode)`,
   `scorecard.cohort.{funnel,previousFunnel,conversions,sources}`,
   `trendWeeklyCohort`. Funnel tab toggle lives in the URL (`?mode=cohort`).
   Cross-week fixtures in `tests/cohort.test.ts`.
6. **Backfill windows** — `backfill_from` = 2026-06-01 (GHL + Stripe + Google);
   `meta_backfill_from` = 2026-07-16 (VSL launch) read ONLY by `lib/meta/ingest`
   (`BACKFILL_DEFAULTS` in `lib/settings.ts`; migration 0006 wrote both and
   cleared the Meta cursor). Meta card has its own date field. Earlier rows are
   kept; earlier ranges are never fetched again.
7. **Meta metrics + Displayed metrics** — `ad_spend` stores reach, frequency,
   cpm/cpc (cents), link_clicks (Meta `inline_link_clicks`), landing_page_views,
   purchases and the whole `actions` map; campaign rows re-derive frequency /
   CPM / CPC from the aggregated row and carry per-campaign ROAS from initial
   cash. `lib/metrics/display.ts` is the catalog (KPI tiles, platform columns,
   tracked columns); `settings.displayed_metrics` (GET/POST
   `/api/display-metrics`) holds the CEO's ticks; defaults on = spend, CPM, CPC,
   link clicks, CPL, cost/consult, cost/roadmap, cost/client, ROAS. The gear is
   on the Ads tab. Everything is pulled and stored regardless.
8. **Ask the dashboard** — `lib/metrics/ask.ts#buildAskContext` (insight
   snapshot + current/prior marketing + both funnel modes + selected weeks +
   trailing 8 weeks + campaign table + data-health notes) →
   `lib/anthropic/ask.ts#askDashboard` (prompt `ASK_SYSTEM` in `prompts.ts`:
   every number must come from the context) → `verifyAnswerNumbers` discards
   any answer whose prose/citations contain a number the context cannot have
   produced → persisted in `ai_reports` kind `ask` with the context hash.
   5 questions/min per warm instance (`checkAskRateLimit`). `AskCard` on the
   Command Center (suggestions, citation chips, history drawer; connect state
   without a key). `POST/GET /api/anthropic/ask`.

Assumptions worth knowing: ROAS is return ÷ spend (the brief wrote "spend ÷
cash", read as a slip); a subscription-only client's first invoice counts as
initial cash (otherwise such clients would never reach ROAS); LTV:CAC is
computed as Σ contract value ÷ spend, which equals the brief's "contract value
÷ blended CAC" once you divide by the client count. `vercel.json` untouched.

## Phase H status (done 2026-09-17 — week-to-week review habit)

- **Period cycler** (`lib/dates`): anchored presets `week` / `month`
  (`?range=week&start=<any day inside>`; `paramsForRange` writes them,
  `rangeFromParams` normalises an anchored period back to `this_week` /
  `last_week` / `this_month` / `last_month` when it coincides). `stepPeriod`,
  `canStepForward`, `periodFamily`, `periodTitle` ("Week of Sep 6–12",
  "September 2026"). `previousPeriod` / `samePeriodLastYear` treat anchored
  periods like their named siblings, so the comparison follows the step.
  `DateRangePicker` renders the arrows on week/month families and handles
  ← → (selects/inputs keep their own keys). Tests cover month, year, short
  and leap-month boundaries and the URL round trip.
- **Scorecard view** (`/scorecard`, `GET /api/scorecard/view`):
  `lib/scorecard/assemble.ts#assembleScorecard(result, narrative)` is THE
  scorecard — Money → Pipeline → Ads stats (formatted value + engine Delta +
  trend key), best/worst campaign by cost per client, funnel / show / source
  tables, CAC line, notes, narrative, subject. `lib/email/digests` renders that
  model (`renderScorecardDigest`); the page renders the same object. Never
  compute a number in either renderer. `Scorecard.previousShowRates` exists
  for the show-rate deltas. `FunnelStrip` now takes `{ funnel, conversions }`
  (any mode). Default range on the page is last_week; the Weekly | Monthly
  toggle writes last_week / last_month and the cycler steps from there.
- **KPI trend popover**: `lib/metrics/trendMetrics.ts` registers each tile
  metric with its honest grain (day/30d for volume & cash, week/12w for rates &
  CAC) and an engine `compute(input, range)`; `service#getMetricTrend` +
  `GET /api/metrics/trend?metric=`; `KpiTrendPopover` is the one component,
  opened by `KpiDeltaTile` when given `trendMetric` (Command Center, Scorecard,
  Ads, Revenue). "Open in Metrics →" lands on `/metrics?metric=<key>` where
  `MetricFocusCard` shows the same series full width. No maturing-data badge
  system exists in the app, so the popover carries none.

## Phase I status (done 2026-09-17 — cohort default + maturing-data disclaimer)

- Funnel tab defaults to "By cohort"; "In period" is `?mode=period`. Each mode
  has a one-line caption under the bars. The Command Center funnel strip is the
  cohort funnel (`scorecard.cohort`).
- Maturing-data disclaimer: `lib/metrics/maturity.ts` (`computeMaturity`,
  `isMaturingMetric`, `isMaturingStage`, `maturingCaveatText`, `dataCaveats`,
  `HISTORY_DEPENDENT_METRICS`). `ScorecardResult.maturity` and
  `MetricTrend.maturing` are set by the service from the two settings.
  `MaturingBadge` is the only renderer (amber = warning tokens, compact
  hourglass on tiles/chips); `KpiDeltaTile` takes `maturity` + `maturing`,
  `Funnel` / `FunnelStrip` take `maturity` and badge consult/roadmap-booked
  rows and every conversion chip, the trend popover badges its header, the
  scorecard assembly flags stats (`ScorecardStat.maturing`) and the email marks
  them "†" with one explanatory note. `tests/maturity.test.ts` pins the two
  conditions, the sunset, and that non-history metrics never badge.

## Phase J status (done 2026-09-17 — authentication, shipped alone)

- `proxy.ts` → `lib/auth/policy.ts#decide` (pure): exempt → allow; no
  APP_PASSWORD/AUTH_SECRET in production/preview → fail closed (HTML 503 for
  pages, JSON 503 for APIs); local dev → skip; else verify the cookie — pages
  307 to `/login?next=`, APIs 401 JSON; a session older than a day is
  re-issued (30-day sliding expiry). `lib/auth/session.ts`: HMAC-SHA256 via
  Web Crypto, `v1.<iat>.<exp>.<sig>`, constant-time signature compare.
  `lib/auth/login.ts`: SHA-256 + `timingSafeEqual` password check, 5
  attempts / min / IP (per warm instance). `POST /api/auth/login` sets the
  `fitflow_session` cookie (httpOnly, Secure on https, SameSite=Lax);
  `POST /api/auth/logout` clears it; NavBar "Sign out"; `/login` page (no
  nav chrome). `tests/auth.test.ts` covers tokens, policy, the interceptor
  end to end, the login route and the rate limit.

## Phase K status (done 2026-09-17 — production findings)

- **Overlay layer**: `components/Popover.tsx` portals every floating panel to
  `<body>` at `--z-popover`, anchored to the trigger's viewport rect (Esc /
  click-away / re-anchor on scroll). `--z-nav < --z-popover < --z-overlay <
  --z-toast` in globals.css; Modal, PeopleDrawer, ⌘K, the Ask drawer and Toast
  use the tokens. The date picker's preset panel and the KPI trend popover use
  `Popover` — nothing floats inside a card any more. The comparison dropdown is
  a native `<select>` (browser-rendered, never clipped). Never use `z-[…]`
  literals or `position:absolute` panels inside cards again.
- **roadmap_noshow** role (after roadmap_booked in every enumeration): aliases
  in the suggester, `NOSHOW_ROLES`, danger tone in Setup / client pages /
  timeline, remap prompt. Not a funnel bar (the chain is booked → showed).
- **Resumable GHL sync** (`lib/ghl/ingest.ts`): a cycle = phase 0 (pipelines,
  stages, users) → the followed pipelines' opportunity pages → appointments →
  the untracked mirrors (order by value since Phase M — see below; contacts
  fetched only when new or changed since the last COMPLETED cycle; cursor
  persisted after every page; `ghl_last_sync_at` = cycleStartedAt and the
  cursor cleared when the mirrors finish). Runs stop STARTING pages at `budgetMs`
  (default 40s; dispatch passes 20s) and finish as status `partial` with a
  progress string; the run that completes the cycle records `succeeded` with the
  cycle's totals (`stats.cycleRuns`). An explicit `since` starts a fresh cycle.
  Position rule: a followed-pipeline opportunity always owns the contact's
  position; an unfollowed one only when the stored position is empty or itself
  unfollowed. `tests/ingest.test.ts` → "resumable cycle".
- **Stale banner**: `GET /api/sync/status` (no GHL call) + `StaleSyncBanner` in
  the layout on data pages when the last COMPLETED GHL cycle is older than
  26 h (or never): "Pipeline data last synced … — Sync now" (POST /api/sync).

## Phase L status (done 2026-09-18 — ops hardening from the production audit)

Findings: Stripe silently unsynced for 16 days because the dispatch chain died
on GHL's timeout before later steps; 115 open incidents, mostly unmapped-stage
noise from 14 unfollowed pipelines.

- **Dispatch isolation** (`lib/dispatch.ts#runDispatch`, pure): every step has
  its own try/catch and timeout race (25 s default; GHL 30 s around a 20 s sync
  budget), a step that would start past the 52 s invocation budget is recorded
  as skipped, and outcomes are recorded separately — sources own their
  `sync_runs` rows, the rest get `dispatch:<step>` rows. Order: stripe → meta →
  google → ghl → reconcile → sweep → insights → narratives → daily / weekly /
  monthly. `tests/dispatch.test.ts`.
- **Nightly reconciliation** (`lib/ghl/reconcile.ts`): one `limit=1` open-
  opportunity search per followed stage (`client#countOpenOpportunities`,
  read-only) vs the mirror's in-stage-now open count; drift beyond
  max(2, 10%) → one open `reconcile_mismatch` incident per stage, refreshed
  while drifting, resolved when it catches up. Summary in settings
  (`ghl_reconcile_summary`), shown in Setup → Sync health ("last reconciled …
  — mirror matches GHL: yes/no", Reconcile now) and in the banner.
  `POST /api/ghl/reconcile`. Skipped while a GHL cycle is still partial.
- **Stale banner** covers GHL, Meta and Stripe (`/api/sync/status`): a
  connected source with no completed run in 26 h is named with its own Sync
  now button; reconciliation drift is shown too.
- **Incident hygiene** (`lib/incidents/noise.ts#sweepIncidentNoise`):
  unmapped-stage incidents for mapped / archived / unfollowed stages, silence
  notices older than 48 h and duplicate errors (all but the newest) auto-
  resolve — at every GHL sync's phase 0, on unfollow, in the dispatch, via
  Setup → Incidents "Resolve all noise" (`PATCH /api/incidents {noise:true}`)
  and `npm run incidents:sweep` (the one-shot cleanup for the 115). Unmapped
  incidents were already only raised for followed pipelines.
- **Stripe webhook registration** is documented in README (endpoint
  `/api/stripe/webhook`, five events, `STRIPE_WEBHOOK_SECRET`, redeploy).
  Run `npm run incidents:sweep` once on production after deploying.

## Phase M status (done 2026-09-29 — the sync cycle ordered by value; staleness by data family)

Production audit finding: 19 consecutive `partial` runs, zero completed cycles
since Sep 18. The cycle walked ALL 15 pipelines' opportunities before ever
reaching appointments, so appointments were 11 days stale, every run row read
"partial — progressing", and `dispatch:reconcile` (which waited for a full
cycle) had never run.

- **Cycle by value** (`lib/ghl/ingest.ts`, cursor gains `phase` +
  `trackedCount`): phase 0 → **tracked** (the FOLLOWED pipelines' opportunity
  pages) → **appointments** (calendar events) → the family markers
  `ghl_tracked_opps_completed_at`, `ghl_appointments_completed_at` and
  `ghl_tracked_completed_at` (= that cycle's cycleStartedAt) + the Stripe
  payment re-match → **mirrors** (untracked pipelines, history only, LAST) →
  done (`ghl_last_sync_at`, cursor cleared, `succeeded`). A budget-limited run
  refreshes everything the dashboard displays before spending a second on a
  mirror. `SyncResult.trackedComplete` / `.phase` say where a run stands. A
  cursor from before this phase (no `phase`) is read as: inside the followed
  block → tracked; past it → appointments next, then the mirrors resume where
  they were — so the first deploy run refreshes appointments immediately.
- **Reconcile eligibility** = the tracked phases complete (the dispatch's
  `ghl` step reports `trackedComplete`), not the 15-pipeline walk. Otherwise
  the step is skipped with the reason "waiting for the tracked phases … —
  paused at …".
- **Staleness truth** (`lib/sync/freshness.ts` pure + tested,
  `lib/sync/ghlFreshness.ts` the one reader): the stale banner and Sync
  health key off "when did the TRACKED phases last complete" PER DATA FAMILY
  (`stages_opportunities`, `appointments`) — never off run activity. A family
  older than 26 h (or never) is stale; runs happening for more than 48 h with
  no completion of a family = `partialOnly`, and the banner / the Sync health
  summary name that family ("appointments: last completed 11 days ago — every
  run since has been partial"). `GET /api/sync/status` carries
  `sources[ghl].families` + `detail`; `GET /api/sync-health` carries
  `families` on the GHL source and `ghlFreshness`. With no marker yet (a
  database that predates this phase) a family falls back to the last completed
  run — the old rule.
- **Every step says why** (`lib/dispatch.ts#statsForOutcome` /
  `outcomeReason`, pure + tested): a `dispatch:<step>` row's `stats` carries
  `reason` for a skip ("not Monday", "waiting for the tracked phases…"), a
  failure/timeout (the error), a stored digest ("stored, not sent —
  RESEND_API_KEY / RESEND_FROM_EMAIL not configured"), an empty digest, a
  not-configured source, a cached insight, a partial GHL run ("partial — paused
  at pipeline 3/15 "Alumni", page 2 (phase mirrors)"). A partial / failed GHL
  run's own row carries `stats.phase` and `stats.reason` ("budget exhausted
  paused at pipeline X "Name", page Y (phase mirrors)"). `sync_runs.stats` is
  typed `Record<string, number | string>` (jsonb; no migration).
- Tests: `tests/ingest.test.ts` → "cycle by value" (the order, the markers,
  the legacy cursor, no followed pipeline) and the moved "resumable cycle"
  expectations; `tests/freshness.test.ts` (family staleness incl. the audit's
  11-day case; the recorded reasons). `vercel.json` untouched; the GHL
  read-only guarantee untouched (`npm run verify:readonly`).

## Audit fixes (2026-09-29 — `docs/audit-2026-09-29.md`)

- **C1 currency** — see rule 8 "Currency". Migration 0008 (`fx_rates` + seed,
  currency-label corrections for refund/subscription rows). Setup → Currency.
- **C2 RLS deny-all** — migration 0009 enables ROW LEVEL SECURITY on every
  `public` table with NO policies: the PostgREST API (anon / authenticated
  keys) reads nothing. The app is unaffected because it connects as the table
  OWNER and RLS is not FORCEd. **Every new table's migration must also
  `ENABLE ROW LEVEL SECURITY`** — `tests/rls.test.ts` fails otherwise (it also
  proves an anon-grant role sees 0 rows and the owner still reads). Never add
  a policy or FORCE without revisiting this.
- **H4 credentials at rest** — see rule 5. `lib/crypto/credentials.ts` (pure:
  key parsing, seal/open, fail-closed status); `db:migrate` then seals legacy
  plaintext rows (`encryptPlaintextSecrets`; also `npm run
  credentials:encrypt`). Setup → `CredentialsKeyNotice` shows on / local
  plaintext / LOCKED. After enabling in production: migrate, then rotate the
  GHL / Meta / Stripe keys. `tests/credentials.test.ts`.
- **H2 Meta token self-check** — dispatch step `meta_token` (right after
  `meta`, 10 s timeout): one GET `/debug_token` (`lib/meta/token.ts`), result
  in `settings.meta_token_status`, shown in Setup → Sync health with "Check
  now" (`POST /api/meta/token`). `assessMetaToken` (pure) considers the token
  AND Meta's data-access window; < 7 days → ONE open `meta_token` warning
  incident "Meta token expires <date> — regenerate in Business Settings";
  expired / invalid → critical and the step fails; resolved automatically
  when a regenerated token checks out. Dispatch order is now stripe → meta →
  meta_token → google → ghl → … `tests/meta-token.test.ts`.
- **H3 backups** — `.github/workflows/backup.yml` (nightly 09:15 UTC +
  manual): pg_dump 17 of `public` + `drizzle` (custom format), refuses a dump
  with < 10 tables of data, encrypts with `openssl enc -aes-256-cbc -pbkdf2
  -iter 200000 -md sha256` (`BACKUP_PASSPHRASE`), proves it decrypts, uploads
  `.dump.enc` + sha256 as an artifact kept 90 days. Repo secrets:
  `DATABASE_URL` (session pooler) + `BACKUP_PASSPHRASE`. Restore:
  `docs/restore-runbook.md`. Restores need the SAME `CREDENTIALS_KEY`.
- **M3 explicit exclusions** — see rule 8 "Payment classes". Migration 0010
  backfills `excluded` with SQL that mirrors `isCashPayment` (proved in
  `tests/excluded.test.ts`); run `npm run reclassify:payments` after
  migrating so any remaining null cash rows get initial / recurring.
- **Test harness**: `vitest.config.ts` `hookTimeout: 30_000` — ~40 files each
  boot PGlite and run every migration in their hooks; the 10 s default
  flaked under parallel load.
- **M1 winter clock** — the Hobby dispatch lands ~13:28 UTC = 6:28am MST from
  Nov 1; the old ≥ 7am guard would have skipped every digest all winter. The
  send window now opens at 6am local (`SEND_WINDOW_START_LOCAL`, one
  predicate for the dispatch and the per-job digest routes); per-period
  dedupe keeps it to one send a day. DST fixtures in `tests/email.test.ts`.
  Digests therefore arrive ~7:28 in summer and ~6:28 in winter (Edmonton).

## Ops runbook — cron heartbeat (2026-09-29)

- **What**: `.github/workflows/heartbeat.yml`, `17 * * * *` (hourly, off
  the top of the hour) + manual. GETs
  `$APP_URL/api/cron/sync-ghl`, then `$APP_URL/api/cron/dispatch` (runs even if
  the first failed), `Authorization: Bearer $CRON_SECRET`, curl `--max-time
  90`. Non-2xx on either → the run fails (red ✗ in Actions). The log prints a
  jq summary (ok / phase / each dispatch step's status + reason), never the
  raw body. Repo secrets: `APP_URL` (origin, no path) and `CRON_SECRET` (same
  value as Vercel's). `vercel.json` is untouched — its daily crons are the
  fallback if GitHub disables or delays the schedule.
- **Minute budget — why hourly, never every 30 min**: GitHub Free = 2,000
  Actions minutes/month for private repos, billed per job ROUNDED UP to the
  minute. A run ≈ 2 billed min → ~1,440/month + nightly backup ~90 ≈ 1,530.
  30-min cadence ≈ 2,900 → GitHub stops the heartbeat mid-month, silently.
  `timeout-minutes: 4` caps a hung run. Any new workflow must redo this sum.
- **Why it is safe to call repeatedly** (audited step by step; every new
  dispatch step must hold the same property):
  - `sync-ghl` / dispatch `ghl`: resumable cycle; each call continues the
    cursor. **One GHL run at a time** — `runGhlSync` returns `skipped` (ok,
    no run row, cursor untouched) while another `ghl_delta`/`ghl_backfill`
    row is live and not stale (overlapping runs would diff the same contacts
    into duplicate `stage_transitions`). Manual Sync now says "Not started".
  - `stripe` (incremental delta hourly, 7-day reconcile daily — see
    "Dispatch fairness + Stripe delta"), `meta` (last 3 days), `google`:
    upserts keyed by external id. `meta_token`: one GET; one open incident at most.
  - `reconcile`: `limit=1` counts per followed stage; one incident per
    stage, refreshed/resolved — idempotent. `sweep`: idempotent.
  - `insights`: the dispatch passes `INSIGHT_MIN_INTERVAL_MS` (20 h) — a
    card for the same period younger than that is served, so the model is
    called ~once a day, not whenever the numbers move. Manual/API calls
    unaffected.
  - `narrative_weekly` / `_monthly`: gated to the 6am-local send window
    (so the run that sends the digest writes it first) and ONE per period —
    an unforced run reuses any stored paragraph for the period.
  - digests: at/after 6am local; `runDigest` decides a period once —
    `sent` → `already_sent`; `stored` / `skipped_empty` → `already_recorded`
    (no new archive row); after `MAX_FAILED_ATTEMPTS` (3) `failed` rows →
    `retries_exhausted`. "Send now" (force) bypasses all of it. Consequence:
    configuring Resend mid-day does not re-send that day's stored digest
    automatically — use Send now.
  - `prune` (`lib/syncRunsPrune.ts`): once per business-local day
    (`settings.sync_runs_pruned_on`) deletes `sync_runs` rows older than 30
    days, keeping the newest row per (kind, status) so Sync health's "last
    run" and the freshness fallback survive for idle sources. Incidents keep
    their text (FK ON DELETE SET NULL). `tests/prune.test.ts`.
- **Volume**: ~14 `dispatch:*` rows per run (~340/day) — bounded by the
  prune to ~30 days. Keep the per-step reasons; prune, never go quiet.
- **Red ✗ triage**: open the run log → the failing step's reason. 401 =
  secret mismatch with Vercel; 503/500 "CRON_SECRET is not configured" =
  Vercel env; 500 with `stuck` = a step not completing 3 runs in a row (see
  its `dispatch_stuck` incident); curl-exit-28 = 90 s timeout; no
  runs at all mid-month = Actions minutes exhausted (Settings → Billing).
  Tests: `tests/ingest.test.ts` → "one GHL run at a time",
  `tests/email.test.ts` (heartbeat-safe / retries), `tests/anthropic.test.ts`
  (minIntervalMs, once per period), `tests/dispatch.test.ts` (reasons).

## Dispatch fairness + Stripe delta (2026-09-30 — production heartbeat 500)

Finding (prod `sync_runs`): `stripe_reconcile` took ~49 s EVERY run with only
5 Stripe requests — it upserted ~330 rows (all 278 subscriptions + 7 days of
charges) one round trip each (~145 ms to Supabase). The dispatch timed it out
at 25 s, then GHL's 30 s ate the rest, so reconcile / sweep / prune / insights
/ **daily** were "time budget reached" on every run since at least 09-26 (the
daily to-do never sent) and the run returned 500.

- **Stripe** (`lib/stripe/ingest.ts`): `delta` (hourly steady state) lists
  charges / subscriptions / refunds CREATED since `settings.stripe_delta_since`
  − 1 h overlap; one INSERT … ON CONFLICT per page (`upsertCharges` /
  `upsertSubscriptions` / `upsertRefunds`, `excluded.*`, refunded_cents only
  grows); matching + classification only when rows were written. Estimated
  ~1–3 s. `reconcile` (7-day charges/refunds + EVERY subscription, catches
  cancellations) runs when `stripe_reconcile_completed_at` is ≥ 20 h old
  (`scheduledStripeMode`), page by page with `stripe_sync_cursor`, stopping
  new pages at `budgetMs` (≥ 1 page per run) → `partial`, resumed next run;
  the marker = the cycle's start. Backfill is resumable the same way. Row
  kind `stripe_delta` is in every freshness / sync-health list. The client
  resolves the (encrypted) key once per list, not per page. Matching picks
  the oldest contact on a shared email/phone (deterministic).
  `npm run sync:stripe -- --delta`. `tests/stripe-incremental.test.ts`.
- **Fairness** (`lib/dispatch.ts#orderSteps`, history in
  `settings.dispatch_state` via `lib/dispatchState.ts`): never-succeeded or
  starved (stuck > 0) steps first, most starved first; then
  least-recently-successful; ties = declared order. `after` deps (reconcile
  after ghl; weekly/monthly after their narrative) are HOISTED to run just
  before the dependent. A budget skip is `deferred` (sync_runs status
  `deferred`), not `skipped`.
- **GHL in the dispatch is a fallback**: `ghlFallbackGate` skips it unless no
  GHL run finished OK (succeeded / partial) for 2 h — the heartbeat's
  `/api/cron/sync-ghl` call normally covers it. Reconcile eligibility reads
  the persisted cycle (`reconcileGate`: cursor phase / tracked marker / no
  live GHL run), never "did ghl run earlier in this dispatch".
- **Status contract** (`assessDispatch`): 200 `{ok:true, partial}` when steps
  were merely deferred or timed out once; **500 only** for a failed step, or
  the same step timed out / deferred `STUCK_THRESHOLD` (3) runs in a row —
  that also opens ONE `dispatch_stuck` critical incident naming the step
  (refreshed while stuck, auto-resolved when it completes). Body carries
  `failed`, `stuck`, `deferred`, `order`. A red ✗ in Actions now means broken.
- Tests: `tests/dispatch.test.ts` (ordering, starvation simulation, status
  contract, gates), `tests/dispatch-state.test.ts` (incident lifecycle).

## AI calls (2026-09-30 — the strict-schema 400)

The first live "Ask" returned `Anthropic 400: For 'array' type, property 'maxItems' is not
supported`. Unit tests mocked `fetch`, and Verify was a plain ping, so nothing had exercised the
API's rules.

- **One call path.** Every feature (Ask, Insights, narrative, remap, Verify) goes through
  `lib/anthropic/client.ts#askClaude`. It sends a forced strict tool whose schema is
  `toStrictToolSchema(schema)` (`lib/anthropic/strictSchema.ts`).
  - The sanitizer removes everything strict tool use rejects: `minimum`/`maximum`/`multipleOf`,
    `minLength`/`maxLength`, `pattern`, `maxItems`, `minItems` > 1, unsupported `format` values.
    It appends each removed limit to the field description, and closes every object
    (`additionalProperties: false`, all fields required).
  - Schemas in `prompts.ts` state the REAL limits. The Zod response schemas enforce them:
    findings > 3 and citations > 30 are trimmed with a warning, remap confidence is clamped to 0–1,
    and any other violation fails with its path.
  - **Contract test** `tests/anthropic-schema.test.ts` checks every `*_TOOL_SCHEMA` and the wire
    body `askClaude` sends. Never send a strict schema any other way.
- **Errors** read `Anthropic <status> · <type>: <message> (request_id …)`. Anthropic returns no id
  on auth errors.
- **Retries and the incident.** No SDK retries; a transient failure (429, 529 overloaded, 5xx,
  408/409, network) is retried once.
  - Still failing → ONE open `anthropic_error` incident at **warning**.
  - 400/401/403, other 4xx, or a missing or invalid structured answer → **critical**.
  - The next success resolves it (`lib/anthropic/incident.ts`).
- **Verify** (Setup → Anthropic) makes a real strict structured call. It shows "Connected ·
  verified with a structured call · <model>", or "Verification failed: <exact error>".
- **Ask card:** an API failure reads "AI request rejected: …" with a Retry button (`errorKind`
  api / grounding / rate_limit / input).
- **Dispatch:** a step whose credentials are missing is `skipped` ("not configured — no credentials
  for this step"), never `succeeded`. A skip resets the stuck counter, so it never opens
  `dispatch_stuck` and never returns 500. A healthy dispatch with Google unconfigured returns HTTP
  200:
  `{"ok":true,"partial":false,"failed":[],"stuck":[],"deferred":[],"steps":{"stripe":{"status":"succeeded",…},"google":{"status":"skipped","reason":"not configured — no credentials for this step"},…}}`.
  `dispatch:insights` reasons: "generated N findings", "served from cache — inputs unchanged",
  "insight for this period generated … — regenerates at most every 20h", or the API error.
- **Live proof:** `npm run smoke:anthropic` (`lib/anthropic/smoke.ts`).
  - Uses the stored key and the database `.env.local` points at. Needs `CREDENTIALS_KEY` there to
    decrypt a stored key; it says so when it's missing.
  - Prints `PASS|FAIL|SKIP <feature> · <model> · <in>/<out> tokens · <output>` and exits 0 only
    when all 4 PASS. SKIP means nothing was exercised: NOT verified.
  - Writes 1 `ask` + 1 `insight` row. The narrative is a dry run (`runWeeklyNarrative(…, {dryRun})`)
    and is never stored, because Monday's digest reuses the stored paragraph. Remap writes nothing.
- `MODEL_OPTIONS` may only list models that accept the forced `tool_choice` askClaude sends.
  Opus 5.5, Sonnet 5.5 and Fable 5.1 reject it, and the contract test fails if one is added before
  `askClaude` handles `auto`.

## Ingestion v2 — Wave 1 (2026-09-30, `docs/plan-rebuild-2026-09-30.md`)

The 2026-09-29 verification proved the engine right (363/363) and the mirror wrong. Wave 1 rebuilds the
ingestion so a stale or incomplete mirror cannot go unnoticed and repairs itself — no manual backfills.

- **F8 timezone** — migration 0011 writes `settings.timezone = America/Edmonton`; `getTimezone()` =
  settings → `BUSINESS_TIMEZONE` → THROWS `TimezoneNotConfiguredError` (never New York). The layout resolves it
  once into `BusinessTimezone` context; a missing zone is a red banner, never a guess.
- **F5 idempotency in the DB** — migration 0012: duplicate transitions deleted then
  `transitions_natural_uidx` (inserts ON CONFLICT DO NOTHING); one `sent` digest per (kind, period);
  `sync_locks` + `lib/syncLock.ts` = the atomic GHL lease (replaces check-then-insert).
- **F1 GHL tracked job every run** (`lib/ghl/ingest.ts`) — ① every page of the followed pipeline (limit 100;
  complete only when it read GHL's `meta.total`, else the run FAILS), contacts re-fetched when new, when their
  opportunity changed, or when no `ghl_opportunities` row exists (so the first run after deploy re-reads
  everyone), then appointments; ② the unfollowed mirrors in a weekly pass (`ghl_mirror_cursor`), leftover
  budget only. Migration 0013: `ghl_opportunities` (RLS), `contacts.opportunity_created_at`, legacy
  `ghl_sync_cursor` cleared (never read again). 429 → one retry after Retry-After. "Sync now" refreshes the
  followed pipeline inside the request: "Followed pipeline: N opportunities refreshed at <time>" or the reason.
- **Markers that cannot lie** (`lib/sync/markers.ts`) — `ghl.opportunities`, `ghl.appointments`, `ghl.mirrors`,
  `meta.spend`, `stripe.payments`, `stripe.completeness`: written ONLY by the code that just fetched that family,
  with counts. The banner and Sync health read markers only; stale = older than **3 h** (or never).
- **F13 Meta currency** — every run reads the account (currency, timezone) first; no currency / not CAD|USD /
  a row contradicting the account → run FAILS, 0 rows, critical incident. Rows of the account with another label
  are relabelled by the run (counted, info incident, idempotent) — self-repair instead of a migration so the old
  code cannot re-label mid-deploy. Windows use the account timezone (America/Los_Angeles; Ads tab documents the
  1-hour boundary). Daily account-level spend check (30 days) re-fetches a differing day; still differs → fail.
- **F12 Stripe completeness** (`lib/stripe/completeness.ts`, dispatch step `stripe_completeness`) — per business
  day since `backfill_from`, per currency, Stripe count + amount + refunded vs the mirror; a differing day is
  re-filled from Stripe and re-checked; still differs → critical incident with both sides. Resumable 30-day
  chunks, full sweep ≤ every 20 h. Migration 0014: `payments.stripe_created_at`. Refund class: parent refunded
  = SUM of its refunds + status `refunded`; a missing parent is fetched; a failed refunds read fails the run;
  webhook `charge.refund.*` is a refund, never a charge.
- **Scheduler (Vercel Pro)** — vercel.json sync-ghl `7 * * * *`, dispatch `37 * * * *`; GitHub heartbeat
  `17 */6 * * *` fallback. Budgets: GHL 200 s; dispatch starts steps until 110 s, step timeouts 60 s default
  (completeness 90 s, GHL fallback 180 s). Every cron call records `scheduler_last_run`; none for 3 h →
  critical `scheduler_silent` incident + red banner (`lib/sync/scheduler.ts`).
- **Deploy order (amendment 2):** `npm run db:migrate` FIRST (0011–0014 are additive / safe for the deployed
  code), THEN `git push`. The first scheduled runs repair the data: the tracked job re-reads the followed
  pipeline and every contact, Meta relabels its rows to CAD, the completeness sweep fills Sep 2–11.

## Ingestion v2 — Wave 2 (2026-09-30)

- **F7 reconcile v2** (`lib/ghl/reconcile.ts`, `npm run reconcile:ghl`) — every followed stage × status
  (open/won/lost/abandoned) + the pipeline total vs `ghl_opportunities`, EXACT. Drift → targeted stage re-fetch
  (+ GET by id for rows GHL no longer lists; 404 deletes) → re-probe; still drifting → one critical
  `reconcile_mismatch` per (stage, status). A probe without `meta.total` → critical `reconcile_skipped` and the
  run fails. Holds the GHL lease.
- **F6 positions** (`ingest#takesPositionRule`, pure) — followed beats unfollowed; otherwise the most recently
  updated opportunity (dates from `ghl_opportunities`, across pages and runs); a tie keeps the holder; an
  unfollowed → unfollowed move writes NO transition.
- **F4 roles at read time** (`lib/metrics/transitionRoles.ts`) — transitions resolve their role through the
  stage NOW (stored role only when the stage is gone). A Setup remap reaches all history; nothing rewrites
  `stage_transitions`.
- **F14 applied** — the followed opportunity's `createdAt` (`ghl_opportunities`), else
  `contacts.opportunity_created_at`; first seen in another pipeline → dated by its entry (counted). No date →
  data-health "N applicants without an application date" (`ScorecardResult.inputHealth`), never the contact date.
- **F3 utm** (`lib/attribution/utm.ts`) — utm_* / fbclid / gclid parsed from the landing URL when GHL's own
  fields are empty (sync), plus a once-only dispatch job `utm_backfill` for every existing contact, then
  reclassification. Migration 0015: `contacts.utm_term`.
- **F2 show rates** — shown ONLY when ≥ 90% of the range's past appointments of that type have an outcome
  (`SHOW_RATE_MIN_COVERAGE`); otherwise "—" + "attendance recorded for 3% of consults (2 of 64)". The AI
  inputs carry the same null + notice and the prompts forbid stating it.
- **FX** — Bank of Canada feed, see rule 8.
- **Spend currency** — manual weekly spend requires CAD|USD (the form preselects the platform's account
  currency when known); Google Ads API reads `customer.currency_code` first (missing → run fails, critical
  `google_currency`); the CSV takes its "Currency code" column or the chosen currency (none / mixed /
  contradiction → nothing imported). Migration 0016 drops the column default.
- **KPI trend drop-down (A1)** — ONE rule for every metric: default last 3 months; 30d daily · 3m / 6m weekly
  (Sun–Sat) · 12m monthly; last bucket to date. Header = the engine value over the window (ratios from totals).
  The card's range is a highlighted band whose value equals the tile (`KpiDeltaTile` requires `trendRange`
  with `trendMetric`). Choice remembered per viewer (localStorage). Replaces "daily 30d / weekly 12w" above.
- **Ask card (A2)** — opens empty (suggestions only); history only behind History; input clears on send.
- **Acceptance harness** — `npm run verify` (`scripts/verify.ts` + `verify.sql`, read-only, GHL through
  `ghlRequest`): engine vs independent SQL for last week / last month / month to date / Jul 16 → today;
  `ghl_opportunities` = live per opportunity and per stage × status; Stripe missing/differ; Meta stored currency
  = account and spend per day; FX = BoC; markers = last fetch; reconcile ok with 0 skipped. Writes
  `docs/verification-<date>.md`; exit 1 on any FAIL.
- **Deploy order:** `npm run db:migrate` (0015 adds a column, 0016 drops a default — both safe for the deployed
  code), THEN `git push`. The first runs repair: `utm_backfill` once, `fx` backfills BoC days.

## FitFlow Analyst — Wave 1 (2026-09-30, `docs/plan-analyst-2026-09-30.md` + amendments)

The runtime, without the panel (Wave 2) or reports (Wave 3). Everything lives in `lib/analyst/`.

- **One call path, its own client.** `lib/analyst/api.ts#buildTurnRequest` is the wire contract
  (`tests/analyst-wire.test.ts`): `client.beta.messages.stream` on `claude-opus-5-5` (default) /
  `claude-fable-5-1` (deep), adaptive thinking with `display: "updates"` and
  `block_binding.prefix_mismatch_behavior: "drop_block"` (betas `thinking-display-updates-2026-08-18`,
  `thinking-binding-controls-2026-08-01`), `tool_choice: auto` (a forced choice is a 400 on both
  models), two system cache breakpoints (contract, brief; 5-minute TTL, nothing else), name-sorted
  NON-strict tools (Zod-validated server-side — see Schemas), the answer as `output_config.format`
  (the one strict schema) — or the strict `submit_answer` tool when the
  probe shows format fails with tools (`settings.analyst_answer_mode`). On-demand compaction
  (`compact-2026-09-04`, `compaction: {type: 'summarize'}`) shares system + tools and carries no
  output format. `askClaude` / `MODEL_OPTIONS` are untouched for the small features.
- **The prefix is frozen.** `prompts.ts#ANALYST_CONTRACT` + the brief are the prefix every thinking
  block is bound to; page context, the data-health line, the explain formula and the preset go in the
  user turn (`composeUserTurn`). Never put a date or a marker in system.
- **A number is shown only with a ref.** Tools return `{ref, range, currency, fx, freshness, data}`;
  a number is cited as `r3:data.kpis.enrollments.current`. `ledger.ts` enumerates every numeric leaf
  of the stored tool results; `verify.ts` rejects a prose number without a declared ref, a declared
  number that does not render its ref (count exact; cents as dollars / 2 dp / 1-dp k; ratio as % or ×),
  a null ref, an unknown ref, a ref older than the newest sync marker. One repair turn, then flagged
  numbers are shown marked. The brief is NOT citeable. `calculate` gives arithmetic a ref and refuses
  to average ratios.
- **Glossary** `lib/metrics/glossary.ts` is the single source of definitions (63 entries,
  `worked(input, range)` = the tile's number); the engine header, ASK/INSIGHTS prompts and the
  Analyst read it. `METRIC_DEFINITION_VERSION = 2026-09-30`.
- **Brief** `brief.ts` (pure, engine only; weekly KPIs since first data, 8/12-week baselines saying
  how many maturing weeks they include, conversions both modes, campaigns, revenue by month,
  seasonality, decisions log, glossary, owner profile with gaps, ACTIVE notes; no build time → same
  data = same hash). Stored in `analyst_briefs`; dispatch step `analyst_brief` once per local day;
  rebuilt on every note / profile change; `npm run analyst:brief` by hand. No brief → the Analyst
  refuses to start.
- **Owner profile + notes** (`notes.ts`): `settings.analyst_owner_profile`; `analyst_notes` rows
  `active` / `proposed` / `rejected` — a proposal never reaches a prompt until approved. Gaps:
  "Withheld until filled: CAC payback, pace to target, funnel-leak $" (Setup, brief, `get_notes`).
- **Tools** (`tools.ts`, 15, read-only, over the page functions, `strict: false` + Zod-validated —
  see Schemas): calculate, compare_periods,
  get_campaigns, get_client, get_data_health, get_funnel, get_metric, get_notes, get_payments,
  get_revenue, get_scorecard, get_stage_people, get_todo, get_trend, list_clients. Names only —
  `scrubContact` drops every email/phone. Errors are error RESULTS. Freshness comes from
  `lib/sync/sourceFreshness.ts` (the banner's reader, extracted).
- **Loop** (`run.ts`, `store.ts`, `service.ts`): append-only log in `analyst_messages` (`api_json`
  TEXT, an assistant row + its tool results in one transaction); refusal / max_tokens store nothing;
  one transient retry from the log; Stop is explicit; past 240 s the turn emits `continue` and the
  client calls `…/continue`; cost estimated from a real token count and capped ($3/run, $150/month
  USD; `needs_confirmation`, re-checked between rounds); the data-health notice is the first event
  and a spend action on stale data is repaired then stripped with the reason; amendment 1: a running
  turn with no heartbeat for 5 min is swept to failed ("the function stopped mid-round and nothing
  resumed it") + one `analyst_turn_failed` incident, on every read and in dispatch step
  `analyst_sweep`. Routes: `POST /api/analyst/turns` (returns at once; runs under `after()`),
  `GET …/turns/[id]/events?after=N` (SSE replay), `POST …/stop`, `POST …/continue`,
  `GET /api/analyst/threads[/id]`, `/api/analyst/{brief,notes,profile,settings,verify}`.
- **Setup → Analyst** card: models, effort, answer mode, caps, brief + Rebuild, Verify (a real
  streamed tool turn — "Connected · verified with a streamed tool call · <model> · …" or
  "Verification failed: <exact reason>"), owner profile with the gaps checklist, notes.
- **Schemas — only the ANSWER is strict; the 15 read tools are `strict: false` and Zod-validated
  server-side; every request to Anthropic is checked against the documented limits IN CODE before
  it is sent; every schema change runs `npm run check:schemas` (2026-09-30, three 400s).**
  Why: the first smoke 400'd on a nullable enum (`{type: ["string","null"], enum}` — use `anyOf`,
  or no nullables at all); the second on the per-request limits (≤ 20 strict tools, ≤ 24 optional,
  ≤ 16 union-typed parameters across every strict tool + `output_config.format`; `count_tokens`
  does NOT enforce them); the third, with the budget at 15/0/0, on "The compiled grammar is too
  large" — a limit with no documented number. So the design changed: the API compiles ONE strict
  schema per request, the answer (`output_config.format`, or the strict `submit_answer` tool in
  fallback mode); the tools are shown to the model with their JSON Schemas but not compiled, and
  `runAnalystTool` validates every input with a Zod validator derived from that same schema
  (`lib/anthropic/jsonSchemaToZod.ts`) — a bad input is an error RESULT naming the path and the
  valid options ("invalid input for get_trend: window: Invalid option: expected one of …"), never
  a throw, never a silent default. The tool schemas still carry no nullables / optionals (every
  field required; sentinels `preset: "custom"`, `""`, `"any"`, `kind: "ref" | "value"`).
  `lib/anthropic/schemaBudget.ts#assertRequestBudget` runs inside `buildTurnRequest` and
  `askClaude` (production counts: 0/20 strict tools · 0/24 optional · 0/16 unions; the submit
  fallback makes it 1 strict tool). The live check `lib/analyst/schemaCheck.ts` MEASURES with real
  `messages.create` calls (max_tokens 64, tool_choice auto, cost reported): static budget →
  `count_tokens` (secondary) → the answer schema alone → the production request (answer strict +
  15 non-strict tools) → informationally, how many tools could be strict alongside the answer
  (binary search). `npm run check:schemas` runs all of it (`--quick` skips the capacity search);
  the probe's first lines run static / answer alone / production; Setup → Analyst → Verify runs
  static / count_tokens / production. A rejection names the step and the API's exact message.
- **Live proof** (Mitchell runs; nothing here is verified until they pass): `npm run analyst:brief`,
  `npm run check:schemas` (~$0.20 USD), `npm run smoke:analyst -- --probe` (every API assumption on the
  PRODUCTION wiring — real tools, real brief, real answer schema, two turns per model, ~$1 USD;
  prints the answer-mode verdict per model) and `npm run smoke:analyst` (one question + a 3-turn
  follow-up on the in-memory store, ~$1 USD). All need `CREDENTIALS_KEY` in `.env.local`.
- **Deploy order:** `npm run db:migrate` (0017: five `analyst_*` tables, RLS on, additive) THEN push.
  The first dispatch builds the brief; or `npm run analyst:brief`.
- Costs are USD everywhere (amendment 6). Prices in `cost.ts` (Opus 5.5 $4/$20, cache read $0.20;
  Fable 5.1 $10/$50, cache read $0.25) — verified 2026-09-30.

## Applied reconciliation — daily (2026-09-30, `docs/plan-reconciliation-2026-09-30.md`)

The Applied definition is deferred (`docs/deferred.md` #1). Until the decision, every day reconciles
Applied under BOTH definitions from the mirror, definition-agnostic, and reports under the current one.

- **Ledger** `applied_ledger` (migration 0018, RLS): one row per opportunity since `backfill_from`,
  recomputed IN FULL daily by dispatch step `applied_ledger` (after ghl; `lib/reconcile/appliedLedger.ts`;
  marker `applied.ledger`; summary `settings.applied_reconcile_summary`). Facts + class + reason:
  A1 new form applicant · A2 returning at Applied · U form applicant, first stage unknown · A3
  pre-existing form contact entered later · C manual entry into a later stage · D non-form at Applied ·
  M moved in · P parked · S second opportunity · X form applicant in an unfollowed pipeline · XN
  non-form there · unresolved (contact not mirrored yet; verdicts NULL). `lib/reconcile/applied.ts`
  classifies; an unknown role throws.
- **Verdicts** live ONLY in `lib/reconcile/definitions.ts`: `verdict_current` is COPIED from the engine
  (`membershipFor().applied` — never re-implemented; `tests/reconcile-ledger.test.ts` and the verify
  harness "Applied ledger · current = engine applied" guard the copy); `verdict_candidate` = deferred #1
  (A1 + A2 + U + X, once per person per day) and is labelled **"candidate — deferred #1, not in use"**
  everywhere (card, API, `get_data_health`). A DECISION flips the registry and `lib/metrics/load.ts`; the
  ledger rows do not change. `ledger_version` = `METRIC_DEFINITION_VERSION`. Sample rows are excluded.
- **Ratio monitor** `applied_ratio_daily` (campaign × Meta ACCOUNT day, tz on the row): dispatch step
  `applied_ratio` (after the ledger; `lib/reconcile/appliedRatio.ts`; marker `applied.ratio`; summary
  `settings.applied_ratio_summary`) reads Meta "Website Submit Applications" per campaign per day
  (`lib/meta/client.ts#fetchCampaignSubmits`: `level=campaign`, `fields=conversions`, explicit
  `action_report_time=conversion` + windows `7d_click,1d_view` — the `submit_application_website`
  action, NOT the `actions` map) for 36 days in ≤7-day chunks. `meta_submits` is NULL when never fetched
  (a failed chunk never overwrites — coalesce); 0 only when the day's request succeeded. FitFlow's side
  is the ledger's counted rows by normalised utm_campaign. `lib/reconcile/ratioDrift.ts` (pure): rolling 7
  ÷ trailing 28 → incomplete · learning · broken_meta · broken_fitflow · insufficient · drift_up /
  drift_down (1.6× / 0.6×, two consecutive days) · stable; hysteresis 1.3× / 0.77×. ONE
  `applied_ratio_drift` warning incident per campaign, refreshed, resolved with `details.resolvedBy`.
  The doc's baseline is ~2× (deferred #4 pixel double-fire); a change in it is the signal.
- **Setup → Reconciliation** (`components/setup/ReconciliationCard.tsx`, `GET/POST /api/reconciliation`):
  one Sun–Sat week (◀ ▶, never past the last complete week), the class table with both columns, people
  one click away (names only), the ratio table with a state badge per campaign and the "Meta days are
  America/Los_Angeles; FitFlow days are America/Edmonton" line, Reconcile now, stale/failed states,
  unresolved always shown. `get_data_health.appliedLedger` carries the same for the Analyst.
- **Live proof:** `npm run smoke:reconcile` (read-only: the last 7 account days per campaign through the
  real Meta path + the ledger's last week + the ratio states); `npm run verify` "Applied ledger" checks.
- **Deploy order:** `npm run db:migrate` (0018, additive) → push. The first dispatch computes everything;
  nothing manual. Unfollowed-pipeline rows lag until the weekly `ghl.mirrors` pass — the card says so.

## Working agreements

- Design system: existing tokens in `app/globals.css` (Linear-style, deep purple accent,
  Inter, dark/light). Reuse `components/` primitives; no new visual languages.
- Typecheck + build + Vitest before calling anything done. Playwright screenshots for
  UI changes (harness in repo history).
- Commit small, descriptive; never commit secrets or `db/*.db`.
- When GHL's real response shape differs from the docs (some fields are undocumented),
  prefer runtime evidence: log the shape once, adapt, note it here.

## Definition of done (Mitchell, 2026-09-30) — applies to EVERY change

Why: the 2026-09-29 verification and the first live AI call found features that "passed" but did
not work. Examples: the Ask/Insights tool schemas used `maxItems`/`minimum`, which strict tool use
rejects (HTTP 400). The unit tests mocked `fetch`, so they never saw the API's rules, and the key
"Verify" button only sent a plain ping. Others: the GHL freshness marker said "fresh" for a frozen
pipeline, Meta currency silently defaulted to USD, and show rates rendered 0% with no input data.
From now on:

1. **The plan states, for each feature or fix:**
   - (a) what it does;
   - (b) **what it looks like when it works**: the exact screen text, API response and DB rows;
   - (c) **what it looks like when it fails**: the visible error, the incident and the `sync_runs`
     status, which must never be a blank, a 0, or "succeeded";
   - (d) **how it is verified**: the automated test AND the live command, with its expected output.
2. **No silent fallbacks.**
   - Never default a missing currency, timezone, status or count; fail closed and surface it.
   - A step that did nothing is `skipped` with a reason, never `succeeded`.
   - A freshness or completion marker is written only by the code that did the work, in that run.
3. **Mocks are not proof.** Every external integration needs:
   - (i) a contract test of the exact request we send against the provider's documented limits
     (fails CI if anyone adds an unsupported field);
   - (ii) a live smoke script (`npm run smoke:<provider>`) that exercises the real call path with
     the stored credentials and prints PASS/FAIL per feature.
4. **Credential "Verify" buttons exercise the same call path the feature uses**, not a cheaper ping.
5. **Report back with evidence:**
   - the test output;
   - the live smoke output (Mitchell runs it if it needs his machine);
   - what was NOT verified.

   Never report "done" on unit tests alone.
