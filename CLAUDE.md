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
   The same endpoint returns pagination meta numbers as STRINGS
   (`meta.nextPage: "2"`) despite the docs — the 2026-09-01 first real import
   parsed 0 opportunities because of it. Every numeric field in
   `lib/ghl/schemas.ts` is therefore coercive (`ghlNumber`: number or numeric
   string); put any new numeric field on that helper.
8. **Metric definitions (Phase G, Sept 1 CEO meeting) — never present a computed
   number whose inputs are missing; show the data-health warning instead.**
   - *Payment classes* (`payments.payment_class`, `lib/stripe/classify.ts`): a
     Stripe customer's FIRST successful, not-fully-refunded charge is `initial`
     (new-client cash) whatever the rail (a subscription-only client's first
     invoice is still initial); every later kept charge — subscription invoices
     included — is `recurring`; failed / pending / fully refunded / refund rows /
     plan rows are never cash and get no class. Customers group by Stripe id, then
     normalised email, then the row alone. Recomputed after every Stripe sync,
     webhook and demo seed; `npm run reclassify:payments` backfills.
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
   - *Roles* consult_rescheduled / roadmap_rescheduled are holding states whose
     occupants appear in the daily to-do "awaiting rebook" bucket every day until
     they leave; previous_lead is a parked row outside the stage chain, and a
     contact whose first observed stage was previous_lead never enters the stages.

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
- Command Center above the fold: KPI row 1 (Initial cash collected, Enrollments,
  Paid CAC, Blended CAC, ROAS) + row 2 (LTV:CAC, Consults booked, Cost per roadmap
  booked) → data-health notice → funnel strip → trend + AI insight card + Ask card.
- Funnel = horizontal proportional bars with ghost drop-off segments and stage→stage %
  chips colored vs trailing 8-week average. NEVER a tapered funnel shape. Bar click →
  drawer with the actual people.
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

## Working agreements

- Design system: existing tokens in `app/globals.css` (Linear-style, deep purple accent,
  Inter, dark/light). Reuse `components/` primitives; no new visual languages.
- Typecheck + build + Vitest before calling anything done. Playwright screenshots for
  UI changes (harness in repo history).
- Commit small, descriptive; never commit secrets or `db/*.db`.
- When GHL's real response shape differs from the docs (some fields are undocumented),
  prefer runtime evidence: log the shape once, adapt, note it here.
