# Plan: daily Applied reconciliation — 2026-09-30

Approved by Mitchell 2026-09-30 (plan mode). One finding per
commit, `npm run check` green between commits, no push, Definition of done for every item
(works / fails / verify). Nothing runs against production; live proof is what you run.

## Context

`docs/applied-reconciliation-2026-09-20.md` reconciled ONE week by hand: 82 Meta "Website Submit
Applications" vs 54 GHL opportunities vs 52 FitFlow applied vs 40 form applicants, every person
classed A1 / A2 / A3 / C / D / X. The Applied definition is deferred (`docs/deferred.md` #1) and the
dashboard carries the honest caveat (82717bc). What is missing is that reconciliation EVERY DAY,
from the mirror: the counts under the current definition and under the candidate, the people behind
each class, and the Meta-to-FitFlow ratio per campaign — so a change in that ratio (the pixel
double-fire fixed, or tracking broken) is noticed the day it happens.

**Definition-agnostic:** the ledger stores the FACTS per opportunity (source, contact created by the
application or pre-existing, first observed stage, position held, followed pipeline, moved-in,
parked) and the class those facts give. The verdicts live in one registry: `current` is DERIVED
FROM THE ENGINE (never re-implemented), `candidate` is deferred #1. A DECISION changes
`candidate` → `current` in that registry; the ledger and the card do not change.

**Reports under the current definition:** every "counted" number on the card equals the engine's
applied for the same days, by construction and by test; the candidate column is labelled
"candidate — deferred #1, not in use" everywhere (card, API, Analyst).

### Reused (found in exploration)
- `lib/metrics/load.ts#loadMetricsInput` already derives per contact: `appliedOn`, `movedIn`,
  `firstRole`, `contactCreatedOn`, `applicationSignal` (only some are emitted today).
- `lib/metrics/index.ts`: `membershipFor(input, range, 'period').applied` (the count),
  `parkedIds`, `computeAppliedCaveat`, `applicationSignal` (stays untouched), `normalizeCampaign`
  (to be exported), `FUNNEL_STAGES`; `lib/metrics/glossary.ts#METRIC_DEFINITION_VERSION`.
- Mirror: `ghl_opportunities` covers every pipeline (followed every run; unfollowed weekly, marker
  `ghl.mirrors`); `processOpportunityPage` also fetches the contact of a new/changed unfollowed
  opportunity, so X rows need no extra GHL call — they lag until the weekly pass.
- Meta: `lib/meta/client.ts#metaRequest` (GET only, Zod, token scrubbed), `chunkWindows`,
  `settings.meta_account.timezone`; the campaign-level `conversions` request and the
  `submit_application_website` pick from `scripts/reconcile-applied.ts#meta()`.
- Patterns: `lib/ghl/reconcile.ts` (sync_runs row, summary in settings, incident
  open/refresh/resolve keyed by `details`, Setup line + "Reconcile now", dispatch gate);
  `lib/analyst/briefService.ts#runAnalystBriefStep` (once per local day, "already ran today at
  HH:MM"); `lib/dispatch.ts` result conventions; `AccordionCard`, `PeopleDrawer`, `FetchError`.

## Design

```
 dispatch, daily (after ghl; gated on the ghl.opportunities marker; "Reconcile now" in Setup)
   ├─ step applied_ledger   lib/reconcile/appliedLedger.ts
   │     loadMetricsInput(backfill_from → today) ─▶ membershipFor(…).applied per day = verdict_current
   │     + classifyApplication(facts) per contact position ─▶ applied_ledger rows (upsert)
   │     + one ghl_opportunities scan adds the rows the engine cannot count: X / XN (unfollowed),
   │       S (a second opportunity of a counted contact), unresolved (contact not mirrored yet)
   │     recomputed IN FULL every day (~1,000 rows since 2026-06-01) — nothing is ever frozen
   ├─ step applied_ratio    lib/reconcile/appliedRatio.ts
   │     Meta campaign-level daily conversions (submit_application_website) for the last 35 days
   │     ─▶ applied_ratio_daily (campaign × day), joined to ledger rows by normalised utm_campaign
   │     ─▶ pure drift rule ─▶ ONE applied_ratio_drift incident per campaign while it drifts
   ├─ settings.applied_reconcile_summary + markers applied.ledger / applied.ratio
   └─ Setup → Reconciliation card · GET/POST /api/reconciliation · get_data_health.appliedLedger
```

### Classes (one row per opportunity; the doc's classes plus the three the review added)
| Class | Facts | current | candidate |
|---|---|---|---|
| A1 | position · followed · form source · contact created within 1 day of the opportunity | yes | yes |
| A2 | position · followed · form source · pre-existing contact · first observed stage = applied | yes | yes |
| U  | position · followed · form source · pre-existing · first stage not observed (A2 or A3 unknown) | yes | yes, flagged |
| A3 | position · followed · form source · pre-existing · first observed stage later than applied | yes | no |
| C  | position · followed · non-form source · first stage later than applied (manual entry) | yes | no |
| D  | position · followed · non-form source · first stage = applied / unobserved | yes | no |
| M  | position · followed · moved in from another pipeline (dated by entry) | yes | no (unverified) |
| P  | position · followed · contact parked (first observed stage previous_lead) | no | no |
| S  | followed · NOT the contact's position (a second opportunity; the engine dates by the held one) | no | no |
| X  | unfollowed pipeline · form source (candidate counts it once per person) | no | yes |
| XN | unfollowed pipeline · non-form source | no | no |
| unresolved | contact row not mirrored yet (weekly pass) | null | null |

`verdict_current` is `true` exactly for the rows whose contact is in `membershipFor(...).applied`
for that day — it is copied from the engine, not computed by the classifier. `verdict_candidate`
is per PERSON per day (an X row is false when the same contact has a followed candidate row).
Two extra facts are stored and counted, never hidden: `contact_created_equals_opportunity`
(`contacts.ghl_created_at` was filled from the opportunity when the contact fetch failed —
`lib/ghl/ingest.ts:926`; an A1 with this flag is "A1 (contact date unverified)") and
`also_in_followed` (load.ts's rule) so the caveat's `otherPipelines` parity holds.

## Items (one commit each)

### 1. Facts out of the loader (additive) + the pure classifier + the definitions registry
- **Change:** `ContactRow` gains optional `ghlOpportunityId`, `contactCreatedOn`, `firstStageRole`,
  `movedInOn`, `parked` — values `load.ts` already holds (lines ~378–406); nothing else in load.ts
  moves; `applicationSignal` is untouched. `lib/reconcile/applied.ts#classifyApplication(facts) →
  { class, reason }` with the table above; `lib/reconcile/definitions.ts`:
  `APPLIED_DEFINITIONS = { current: { label, note: 'derived from the engine — never re-implemented' },
  candidate: { label: 'form applicants (deferred #1, not in use)', counts(row) } }` and
  `LEDGER_VERSION = METRIC_DEFINITION_VERSION`. Export `normalizeCampaign`.
- **Works:** the doc's 55 people as fixtures → the doc's classes (A1 40, A3 1, C 7, D 3, X 3, plus
  Nuala = M); `classifyApplication(f).class ∈ {A1, A2, U}` ⇔ `applicationSignal(f).signal === 'form'`
  on every fixture in `tests/applied-caveat.test.ts`.
- **Fails:** an unknown role / missing followed flag throws (never a silent class).
- **Verify:** `tests/reconcile-applied.test.ts`; existing suites unchanged and green.

### 2. Migration 0018 + the ledger job — `lib/reconcile/appliedLedger.ts`
- **Change:** table `applied_ledger` (RLS on): `opportunity_id` PK, `ghl_contact_id`, `contact_id`,
  `name`, `pipeline_id`, `pipeline_name`, `pipeline_followed` ("pipeline now"), `holds_position`,
  `first_role`, `stage_now`, `contact_source`, `form_source`, `contact_created_on`,
  `contact_created_equals_opportunity`, `opportunity_created_on`, `applied_on` (the engine's date;
  null when not counted), `moved_in_on`, `parked`, `also_in_followed`, `utm_campaign`,
  `campaign_key`, `class`, `reason`, `verdict_current` (bool, null = unresolved),
  `verdict_candidate` (bool, null), `ledger_version`, `computed_at`; indexes on `applied_on`,
  `opportunity_created_on`, `campaign_key`, `ghl_contact_id`. `origin='demo'` rows are excluded
  (the summary says "N sample rows excluded" while any exist).
  `runAppliedLedger({trigger})`: `loadMetricsInput({start: backfill_from, end: today})` →
  per business day `membershipFor(input, day, 'period').applied` (the current verdicts) →
  classifier over each counted contact's facts → one `ghl_opportunities` query for the window
  (created in it, or moved in — from transitions, not `ghl_created_at`) joined to contacts by
  `ghl_contact_id` for the S / X / XN / unresolved rows (contacts by `ghl_contact_id` and
  transitions by `contact_id` — both indexed; never by opportunity id) → upsert in batches of 500,
  delete window rows whose opportunity no longer exists in the mirror → `sync_runs` row
  (`applied_ledger`, `succeeded` with `stats.reason` = "since 2026-06-01 · 1,012 opportunities ·
  A1 610 · … · unresolved 3 · sample 0 · mirror as of <ghl.mirrors>"; `failed` with the error) →
  marker `applied.ledger` → summary (`settings.applied_reconcile_summary`: ranAt, since, per-class
  counts for the last complete Sun–Sat week (`weekStart`/`weekEnd`), unresolved, sample excluded,
  followed-set, `ledger_version`, mirrorAsOf).
- **Works:** for Sep 20–26, `verdict_current` rows = the engine's 52 and their classes are the
  doc's (whatever the mirror holds that day — the report states the mirror's numbers with the
  `ghl.mirrors` date, not the doc's promise).
- **Fails:** no followed pipeline → `skipped: 'no followed pipeline'`; no `ghl.opportunities`
  marker → skipped "waiting for the first complete read of the followed pipeline"; a DB error →
  `failed` + `error` incident, previous rows untouched; an unresolved row renders as a count on the
  card, never inside a clean total.
- **Verify:** PGlite test with the doc's shapes (A1/A2/A3/C/D/M/P/S/X/XN/unresolved, a contact
  with two followed opportunities, a re-run that changes only `computed_at`); the parity guards —
  Σ `verdict_current` per day = `membershipFor().applied.length`, rows in {A3, C, D, M} for the
  week = `computeAppliedCaveat().withoutFormRecord.length`, X rows with a mirrored contact =
  `otherPipelines.length`; `scripts/verify.sql`/`verify.ts` gain "ledger current (last week) =
  engine applied" (copying load.ts's contact filter, not verify.sql's `c` CTE); `tests/rls.test.ts`.

### 3. Meta submits per campaign per day + the drift rule — `lib/reconcile/appliedRatio.ts`
- **Change:** `lib/meta/client.ts#fetchCampaignSubmits({since, until})`: GET `/insights`,
  `level=campaign`, `fields=campaign_id,campaign_name,conversions`, `time_increment=1`,
  `action_report_time=conversion`, `action_attribution_windows=['7d_click','1d_view']` (explicit,
  so a Meta default change cannot move the series; both in the contract test), Zod for
  `conversions[]`, ≤7-day chunks. Table `applied_ratio_daily` (RLS on): PK `(campaign_id, date)`
  where `date` is the Meta ACCOUNT day (tz stored per row from `settings.meta_account.timezone`;
  unknown tz → the step is `skipped: 'Meta account timezone unknown'`, never the business tz),
  `campaign_name`, `campaign_key`, `meta_submits` (NULLABLE — null = not fetched; 0 only when the
  day's account request succeeded), `fitflow_applied` (ledger `verdict_current` rows with that
  `campaign_key` on that calendar date), `fitflow_form_applicants` (A1 + A2 + U), `fetched_at`.
  Window: last 35 days (5 GETs), rows persist. Unmatched utm rows ("—", "Profile", "TH | TOF
  Quiz") are counted in the summary as "applied rows matching no Meta campaign".
  `lib/reconcile/ratioDrift.ts` (pure, table-tested) per campaign: `rolling7 = Σ meta ÷ Σ fitflow`
  (7 days) vs `baseline` (the 28 days before); states: `incomplete` (any null day in either
  window — lists the days), `learning` (< 28 days of rows or Σ fitflow(28) = 0), `insufficient`
  (Σ meta7 < 10 or Σ fitflow7 < 5, and not broken), `broken_meta` (Σ meta7 ≥ 10, Σ fitflow7 = 0),
  `broken_fitflow` (Σ fitflow7 ≥ 5, Σ meta7 = 0), `drift_up` (rolling7 > 1.6 × baseline for 2
  consecutive days), `drift_down` (< 0.6 × for 2 days), `stable`; hysteresis: a drift resolves
  only back inside 1.3× / 0.77×. ONE open `applied_ratio_drift` incident per campaign (warning;
  `details.campaignId`, `rolling7`, `baseline`, sums, state), refreshed while it holds, resolved
  with `details.resolvedBy` (the reconcile.ts pattern). `sync_runs` kind `applied_ratio`; marker
  `applied.ratio`; Meta not configured → `{ notConfigured: true }` (dispatch records it).
- **Works:** Sep 20–26 rows read Scaling 38 / 19, New VSL 34 / 15, Testing 10 / 4 (the doc's §4);
  the summary line "Meta counts 2.1× FitFlow's applications over 7 days — stable (deferred #4
  pixel double-fire)".
- **Fails:** a Meta error → `partial` with the error, existing rows kept, the affected days null →
  `incomplete`; no `conversions` for a campaign-day whose request succeeded → 0 with the day
  marked fetched.
- **Verify:** `tests/reconcile-ratio.test.ts` (every state on the doc's numbers: stable ~2×, a
  halving → drift_down + incident, Meta 30 / FitFlow 0 → broken_meta, nulls → incomplete never 0,
  hysteresis resolve, learning); a contract test of the exact Meta request; PGlite parity
  `fitflow_applied` per campaign-week = `computeCampaignTable(input, week)[campaign].tracked.applied`;
  live: `npm run smoke:reconcile` prints the last 7 days per campaign from Meta and the ledger.

### 4. Dispatch steps, API, Setup → Reconciliation card
- **Change:** steps `applied_ledger` (`after: ['ghl']`, `ownsRun`, 30 s) and `applied_ratio`
  (`after: ['applied_ledger']`, `ownsRun`, 45 s), each once per local day ("already ran today at
  HH:MM"; `force` bypasses). `GET /api/reconciliation?week=<sunday>` → `{ summary, ledger:
  { week, byClass: { A1: { count, people[{name, link, reason}] } … }, current, candidate,
  candidateLabel: 'candidate — deferred #1, not in use', otherPipelines, unresolved, sampleExcluded,
  mirrorAsOf, ledgerVersion }, ratio: { campaigns[{ id, name, days[{date, meta, fitflow}],
  rolling7, baseline, state }], metaAsOf, metaDayTz, unmatchedUtmRows } }` (names only, no
  contact details); `POST /api/reconciliation` = Reconcile now (both steps, `maxDuration = 60`).
  `components/setup/ReconciliationCard.tsx` between SyncHealth and IncidentLog: header "Sep 20–26:
  52 counted · 40 form applicants · Meta 2.1× (stable)"; the class table with BOTH columns
  (candidate labelled as above, `U` rows flagged, `contact date unverified` counted); each count
  opens `PeopleDrawer`; the ratio table per campaign (7 days) with a `Badge` per state and the
  line "Meta days are America/Los_Angeles; FitFlow days are America/Edmonton"; "mirror as of" /
  "Meta as of"; ◀ ▶ over complete weeks; Reconcile now; open drift incidents; the "Definition under
  review — docs/deferred.md #1" note.
- **Works:** the card for Sep 20–26 shows the mirror's numbers with their date; "C · 7" lists the
  seven names.
- **Fails:** no run yet → "Not reconciled yet · Reconcile now"; a failed run → the error AND the
  previous summary's date marked stale; unresolved > 0 always shown; loading errors via
  `FetchError` + Retry.
- **Verify:** route test on PGlite; static test that Setup mounts the card; Playwright screenshots
  in both themes; `npm run verify` PASS on the new checks.

### 5. Analyst + glossary + docs
- **Change:** `get_data_health` gains `appliedLedger` (week, current, candidate + label, byClass
  counts, otherPipelines names, unresolved, ratio states per campaign, `definitionUnderReview:
  true`, `deferred: 'docs/deferred.md #1'`); the glossary's Applied entry points at Setup →
  Reconciliation; `docs/deferred.md` #1 gains "Evidence: Setup → Reconciliation, both columns";
  CLAUDE.md "Reconciliation" section (tables, classes, registry rule, drift states, commands).
- **Verify:** tools parity + PII tests extended; glossary test.

## Deploy order
`npm run db:migrate` (0018: `applied_ledger`, `applied_ratio_daily`; additive; RLS on) → push. The
first dispatch runs both steps (full window since 2026-06-01 + 35 Meta days); nothing manual.

## What you run to prove it
`npm run check`; after deploy: Setup → Reconciliation for Sep 20–26 (report the mirror's numbers
with the `ghl.mirrors` date next to the doc's 40 / 1 / 7 / 3 / 1 / 3), `npm run verify` PASS on
"ledger current = engine applied", `npm run smoke:reconcile`.

## Dropped / deferred
No definition change (deferred #1); no `load.ts` refactor and no `applicationSignal` wrapper (the
loader only EMITS facts it already has); no window setting or month toggle (last complete weeks
only; month later); no Command Center notice sentence; no GHL forms API (deferred #2 — the
classifier gains a `submission_at` fact when the scope arrives); no Events Manager check (deferred
#4); no weekly Claude check (deferred #9, after this ships); no digest line.
