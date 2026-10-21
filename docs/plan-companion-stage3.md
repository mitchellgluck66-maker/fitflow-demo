# Onboarding Companion — Stage 3 plan (2026-10-21)

Jake's Onboarding page + three switchable emailed reports (Daily / Weekly / Monthly). Read-only: no new
GoHighLevel write — every GHL read goes through `ghlRequest`, `scripts/verify-readonly.sh` stays unchanged.
Builds on commit `d7076e4` (the midnight schedule, "Sends ~12:40 am", the weekend setting, Meta "still
settling") — nothing there is redone. Design reference: the approved canvas ("Onboarding Review Demo").

Order of work, one commit each: 1 page → 2 reports → 3 settings → 4 Users fix → 5 proof. `npm run check`
green between commits. Not pushed.

## Shared design decisions

- **One numbers function.** `lib/onboarding/numbers.ts#onboardingNumbers(calls)` is pure and the ONLY
  place the six tiles, the needs-attention list and the week sums are computed; the page, the CSV and all
  three emails call it. A call is one Companion call (stage 1's `CompanionCall`) joined to its newest
  non-undone `companion_actions` row (`OnboardingLog`: outcome key + label, note, before → after with the
  after stage's ROLE resolved through the stages table, deal status, steps, state, dry run, user, time).
- **Who is a companion user:** `app_users` with role `onboarding`, `active`, and a linked GHL user. Their
  calls = `appointments` assigned to that GHL user (stage 1's rule, `isAssignedTo`), every calendar.
- **Source:** the mirror for any past day and for the week; TODAY on the Day view reads live per user through
  stage 1's `loadDayRaw` (2-minute cache, the mirror on failure with the amber "showing data from <time>"
  line and the reason). The emails always read the mirror (they run after midnight for a closed period).
- **Rules (the numbers function):**
  - `logged` = a live (not undone) log exists, whatever its state (a failed log still recorded Miranda's
    outcome; its GHL failure is a needs-attention item). Dry-run logs count as logged.
  - `showed` = the log's after-appointment is `showed`, or — with no log — GHL already records `showed`.
    No-shows likewise (`noshow`); `consult · roadmap` split by call type.
  - `roadmapsBooked` = logs whose after stage resolves to the role `roadmap_booked`;
    `enrolled` = after role `enrolled` or deal `won`; `notFit` = deal `lost`.
  - `needsAttention` = calls whose stage-1 status is `needs_outcome` (ended, no log, no GHL outcome) plus
    calls whose newest log is `partial` / `failed` (stale `running` rows count as failed, stage 2's rule).
    A call GHL already marked cancelled / showed / no-show without a Companion log is NOT attention.
  - `showedPct` = showed ÷ logged (the canvas: "4 · of 7 logged · 57%"); null when logged = 0.
- **Report kinds** become `daily | weekly | monthly` (the archive keeps old `daily_todo` rows and labels
  them). Every figure comes from the engine (`computeScorecard`, `computeAdsKpis`, `computeRevenue`,
  `weekVerdictFor`, `computeSpendGates`, `scorecardBaselines`, `computeShowRates`) or from the onboarding
  numbers function — the renderers format, never compute. The partial-data rule travels as the engine's
  `Coverage` ("Based on X of Y"); a source with no data says so ("awaiting Stripe", "no spend rows") — never 0.
- **Settings** (migration 0023, additive): `report_<kind>_enabled` (`'true'` only; default OFF),
  `report_<kind>_recipients`; the migration copies the old `digest_enabled_*` rows only where they were
  stored explicitly `'true'` (an absent row was "on by default" before — now it is OFF until the owner flips
  it, as the brief says) and the old recipients. `digest_include_weekends` stays (d7076e4).
  `email_digests.is_test boolean default false`: a test send is archived but ignored by the per-period
  idempotency, so it never counts as the scheduled send.
- **The to-do lists** (Day-1 / Day-3 / awaiting rebook) stay in the daily email as its last section
  ("Follow-ups for today") — the brief does not list them, and dropping Miranda's call list silently would be
  a regression. Say the word and they go.

## 1. Onboarding page `/onboarding` (owner only)

**Does:** nav tab "Onboarding" between Clients and Reports. Day (default today) or Week (Sun–Sat), business
timezone, ◀ ▶, deep link `?date=YYYY-MM-DD&range=day|week`. Six tiles, the amber "N need attention" bar
first, filter pills (All · Needs attention · No-shows · Enrolled · Not a fit), one table (time + type ·
client → profile, "Logged h:mm by <user>" · outcome chip · stage before → after + Won/Lost · note · GHL
result ✓ Updated / ! Partly failed with per-step ✓ ✗ / Not logged / Dry run — not sent / Undone), Retry on
partial rows through stage 2's `POST /api/companion/actions/{id}/retry` (owner reaches every log). Export
CSV. Empty state ("No onboarding calls on <day>"), week view (same table, a date column).
`GET /api/onboarding?date&range[&format=csv]` is the one data route; `lib/onboarding/service.ts` the one
call path. Role: `/onboarding` + `/api/onboarding` are outside the Companion, so the existing rule already
sends an onboarding login to `/companion` (pages) / 403 (APIs) — both paths join the role tests.

**Works:** `/onboarding?date=2026-10-21&range=day` shows "Calls 8 · 5 consults · 3 roadmaps", "Logged 7 of
8", the bar "2 need attention — 4:30 pm consult with Ben Sato has no outcome logged · 1:00 pm roadmap with
Megan Ortiz: the note didn't reach GoHighLevel", rows with the chips above; CSV downloads
`onboarding-2026-10-21.csv` with one row per call. `/api/onboarding` returns `{ range, start, end, timezone,
users, source, calls[], numbers, attention[] }`.

**Fails:** no companion user → the page says "No onboarding login with a GoHighLevel user — Setup → Users"
(API: `users: []`, `calls: []`, `reason`). Live GHL down today → the amber line names the mirror's `asOf`
and the reason; the mirror empty → "No synced calls". An onboarding login gets `/companion` (page) or 403
(API). A retry that fails stays red with the error from the route.

**Verify:** `tests/onboarding-numbers.test.ts` (undone / dry run / partial / failed / no log / GHL-only
outcomes / week sums / needs-attention rules / CSV), `tests/onboarding-service.test.ts` (PGlite: two
companion users, a week, the role rule on both paths, the API's CSV), screenshots
`onboarding-day`, `onboarding-week`, `onboarding-empty`, `onboarding-day-mobile` (demo tenant: the seed
adds Companion logs — ok, partial, dry run — and an unlogged ended call to Miranda's latest day).

## 2. Three reports (`lib/reports/`)

**Does:** `daily.ts` / `weekly.ts` / `monthly.ts` build a `ReportModel` (subject, headline, totals, needs
attention, sections, button); `render.ts` turns it into HTML + text with `lib/email/templates`;
`run.ts#runReport(kind, { force, test, to })` replaces `runDigest` (same archive table and statuses; the
per-period decision, `MAX_FAILED_ATTEMPTS`, Resend-missing → `stored`).

- **Daily (yesterday):** applied · consults booked · showed · enrolled (GHL stage entries, the maturing
  caveat when active) and first payments (Stripe); ad spend (Meta "still settling" < 48 h, d7076e4's
  rule); cash collected; cost per applicant and per enrollment; each vs the same weekday last week
  (`computeScorecard(input, day, day − 7)`); the full Onboarding section (totals, needs attention, every
  call with outcome + note); data-health line (open warning/critical incidents, stale sources from
  `readSyncStatus`); then the follow-ups. Subject: `Daily · Tue, Oct 20 · 3 applied, 1 enrolled, 1 call
  needs an outcome`.
- **Weekly (Sun–Sat just ended):** `getScorecard({ range: 'week', start, compare: 'previous_period' })` →
  Money / Pipeline / Ads stats (the scorecard assembly, unchanged), the verdict (`result.verdict`, the same
  function the Analyst cites: strong / normal / weak vs the clean 8-week baseline, with its basis phrases),
  cost per stage (the funnel rows' cost-per column), spend changes allowed / blocked (`result.spendGates`),
  onboarding week (calls, show rate, roadmaps booked, enrolled, no-shows, unlogged), top 3 changes vs last
  week (the three stats with the largest |pct| delta, from the assembled stats — no new math), needs
  attention (unlogged + failed logs of the week). Subject: `Weekly · Oct 18–24 · normal week: 4 new clients,
  $9,600 CAD`.
- **Monthly (month just ended):** `getScorecard({ range: 'month', start, compare: 'previous_period' })` +
  the three prior months computed from ONE `loadMetricsInput` window with `computeScorecard` per month
  (pure) for the 3-month average: funnel, cash collected, spend, CAC, show rates, onboarding month, best and
  worst week (`trendWeekly.current` by new-client cash, enrollments as the tie-break), needs attention.
  Subject: `Monthly · September 2026 · 14 new clients, $33,500 CAD vs $29,100 avg`.
- Each: headline sentence from the numbers, totals, Needs attention FIRST, details, a button to the matching
  page (`/onboarding?date=`, `/scorecard?range=week&start=`, `/scorecard?range=month&start=`).

**Works:** `npm run reports:preview -- --report daily --date 2026-10-20` prints the model's numbers and
writes `docs/screens/report-daily-2026-10-20.html` without sending; the dispatch rows `dispatch:daily` /
`weekly` / `monthly` read `sent` (or `stored` with the Resend reason).

**Fails:** a report whose source has no data says so in that section ("Stripe: no payment rows" / "Meta: no
spend rows for Oct 20") — never 0; a builder error → the run row `failed` with the message, nothing
archived half-written; the 3rd failure for a period opens ONE `report_failed` warning incident
(`details.kind`, `period`), resolved by the next successful send of that kind.

**Verify:** `tests/reports-build.test.ts` — each builder on a normal, a partial-data and an empty period
(PGlite fixtures; the subject lines; "Based on X of Y"; "awaiting Stripe"); `tests/reports-send.test.ts`
(below).

## 3. Reports settings on `/reports` (owner)

**Does:** one card per report: On/Off (default OFF), recipients (validated — the save refuses an invalid
address and names it), "Include weekends" on the Daily card, last sent / next send (from
`reportDecision` — "Sun, Oct 25 ~12:40 am") / last error, Preview (the real email for the latest period,
in-page), Send test to me (to the signed-in login's email; archived with `is_test`, never the scheduled
send; the team-password owner has no email → the button says so). On with no recipients or no Resend key
→ the card shows the reason ("On, but nothing will send: no recipients" / "…RESEND_API_KEY not set"); the
scheduled run records `stored` / `failed: No valid recipients configured` as today. Failed send: retried
on the next run; after 3 failures the incident; every attempt is an `email_digests` row.
Routes: `GET/POST /api/reports/settings`, `GET /api/reports/preview?kind=&date=`,
`POST /api/reports/test`. The archive stays (old `daily_todo` rows labelled "Daily to-do (retired)").

**Works:** flip Weekly on, add `jake@…`, Save → the card reads "On · next send Sun, Oct 25 ~12:40 am ·
last sent never"; "Send test to me" → the toast "Test sent to <me>" and an archive row marked Test.

**Fails:** save with `jake@` → 400 "Invalid recipient: jake@" and nothing saved; Resend unset → the test
button is disabled with the reason; a test that Resend rejects → the toast carries Resend's message and the
archive row `failed`.

**Verify:** `tests/reports-send.test.ts` — off switch = `disabled`, nothing built; no recipients → `failed`
row with the reason; no key → `stored` with the reason; a test send never satisfies the period; 3 failures
→ `retries_exhausted` + the incident, resolved on success; migration 0023 copies explicit `'true'` and
recipients, leaves absent rows OFF. Screenshots `reports` (the cards).

## 4. Setup → Users: the one-time password stays

**Does:** the password banner after Add user / Reset password stays until "Done", with a Copy button. Cause:
the card's `defaultOpen` is "no onboarding user yet", so adding the first user collapsed the card and hid
the banner. The card stays open while a password is on screen; the banner survives reloads of the list.

**Works / fails / verify:** add a user → the banner with the password and Copy ("Copied"); the list refreshes
beneath it; Done clears it. Clipboard refused → "Copy failed — select the password instead" (it is
`select-all`). `tests/users-card.test.tsx` is out of scope (no DOM harness); the behaviour is in the
screenshot `setup-users-password` (demo) and in the stage report's by-hand list.

## 5. Tests + proof

- Unit: items 1–3 above (`tests/onboarding-numbers`, `tests/onboarding-service`, `tests/reports-build`,
  `tests/reports-send`, the role rule in `tests/companion-auth`).
- `scripts/reports-preview.ts` (`npm run reports:preview -- --report daily|weekly|monthly --date
  YYYY-MM-DD`): prints the numbers and writes `docs/screens/report-<kind>-<date>.html`; never sends.
- Screenshots: `npm run screenshots -- --onboarding` → `onboarding-{day,week,empty,day-mobile}`, `reports`,
  `report-{daily,weekly,monthly}` (the preview route rendered at 680 px), both themes, demo tenant.
- `docs/companion-stage3-report.md`: works / fails / what Mitchell verifies by hand (Resend key in Vercel,
  recipients, turning each report on, the first scheduled sends, `reports:preview` on real dates).

Deploy order: `npm run db:migrate` (0023 — a column with a default and settings rows; safe for the deployed
code) THEN push; then /reports → turn each report on.
