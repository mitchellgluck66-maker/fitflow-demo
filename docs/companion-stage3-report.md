# Onboarding Companion — Stage 3 report (2026-10-21)

Jake's Onboarding page + the three switchable reports (Daily / Weekly / Monthly), built on commit `d7076e4`
(the midnight schedule). Six commits on `main`, not pushed; `npm run check` green after each; read-only —
`scripts/verify-readonly.sh` unchanged and passing (no new GoHighLevel write). Plan: `docs/plan-companion-stage3.md`.

## What works (verified by tests, the demo tenant and read-only runs on the real tenant)

1. **`/onboarding`** (owner only; an onboarding login is sent to `/companion`, the API answers 403 — both in the
   role tests). Day (default today) / Week, ◀ ▶, `?date=&range=`. Six tiles, the amber "N need attention" bar first,
   the five filter pills, one table (time + type · client → profile + "Logged h:mm by <user>" · outcome chip · stage
   before → after + Won/Lost · note · GoHighLevel: ✓ Updated / ! Partly failed with Stage ✓ · Appointment ✓ · Note ✗
   and **Retry** / Not logged / Dry run — not sent / Undone), Export CSV. Today reads live per companion user
   (stage 1's loader, 2-minute cache; the mirror on failure with the amber "showing synced data from <time>" line
   and the reason); past days and the week read the mirror. `lib/onboarding/numbers.ts` is the ONE numbers
   function the page, the CSV and the emails share. Screenshots: `docs/screens/{light,dark}/onboarding-{day,week,
   empty,day-mobile}.png` (demo tenant — the seed now plants an ok log, a partial log, a dry run, an unlogged
   ended call and an undone log on Miranda's latest full day).
2. **The three reports** (`lib/reports/`): every figure from the engine (`computeScorecard`, `computeAdsKpis`,
   `computeRevenue`, `weekVerdictFor`, `computeSpendGates`, `computeShowRates`, the scorecard assembly) or the
   onboarding numbers function; the renderer formats, never computes. Headline → totals → **Needs attention
   first** → details → a button to the page. Partial data travels as "Based on X of Y"; a missing source says so
   ("awaiting Stripe", "no spend rows for <day>", "attendance recorded for 8% of consults — show rate needs
   90%") — never 0. Subjects: `Daily · Tue, Oct 20, 2026 · 7 applied, 3 consults booked, 0 new clients paid, 7 calls
   need attention` / `Weekly · Oct 11–17 · strong week: 5 new clients, $9,658.20 CAD` / `Monthly · September 2026 ·
   21 new clients, $34,764.80 CAD vs $28,585.34 CAD avg`.
3. **`/reports` cards**: On/Off (default OFF), validated recipients (an invalid address refuses the save by name),
   Include weekends on the Daily, next send ("Sun, Oct 25, 2026 ~12:40 am · 2026-10-18 → 2026-10-24"), last sent,
   last error, the reason while on but unable to send ("On, but nothing will send: no recipients" / "…RESEND not
   set"), Preview (the real email for the latest period, in-page), Send test to me (archived with `is_test`, never
   the scheduled send; 409 for the team-password owner). Screenshot: `reports.png`.
4. **Setup → Users**: the one-time password stays until Done, with Copy (the card no longer collapses when the
   first onboarding user is added).
5. **Schedule and runner**: unchanged from `d7076e4` (first run after 00:00 business time, daily = yesterday,
   weekends off unless the setting, weekly = Sunday, monthly = the 1st); the runner is per-period idempotent;
   the 3rd failure for a period opens ONE `report_failed` warning incident, resolved by the next sent.

## Numbers

- `npm run check`: typecheck · **108 files / 1067 tests** · verify:readonly · build — green.
- New tests: `onboarding-numbers` (6), `onboarding-service` (6, PGlite), `reports-send` (8), `reports-build` (5, the
  demo tenant), `reports-settings` (5), the role paths in `companion-auth`; `maturity` / `scorecard` /
  `partial-data` moved onto the pure `weeklyModel`.
- `npm run reports:preview` on the **real tenant** (read-only; output sent to a scratch folder because it carries
  client names), 2026-10-21:
  - Daily · Tue, Oct 20: 7 applied (+3 vs last Tuesday), 3 consults booked, 0 first payments, cash collected
    $2,230 CAD, ad spend $536.58 CAD **still settling**, cost per applicant $76.65 CAD; 8 onboarding calls, **0 logged**
    (stage 2 is not live yet, so all 7 ended calls "need attention"); data health fresh, no open incidents.
  - Weekly · Oct 11–17: **strong week** — 5 new paying clients vs 4/week (1.25×), $9,658.20 CAD vs $6,754.21/week
    (1.43×); enrollments 1 (−50%); spend $3,485.10 CAD; gates: account and the July 16 VSL campaign may change, the
    Sept 7 Scaling / Testing, July 22 Retargeting and the Test campaign HOLD; 27 onboarding calls, 24 unlogged.
  - Monthly · September 2026: 21 new clients, $34,764.80 CAD vs the $28,585.34 CAD 3-month average; 23 enrolled
    (+64%); spend $15,035.74 CAD (+52%); best week Sep 20–26 ($16,294.40 CAD, 8 enrolled), worst Sep 6–12
    ($4,149.60 CAD); 150 onboarding calls, 137 unlogged.
  Every number above is the engine's for those periods — the same functions the dashboard renders.

## What fails, and how it shows

- A report whose builder throws → the dispatch row `dispatch:<kind>` is `failed` with the message; nothing is archived.
- No Resend key → `stored` rows with the reason, the card says "On, but nothing will send: RESEND_API_KEY …".
- No recipients → `failed` rows "No valid recipients configured"; the 3rd one opens the incident.
- GoHighLevel down on today's Day view → the mirror with `asOf` + the reason (amber line); the mirror empty → "No
  synced calls".
- No companion user → "No onboarding login with a GoHighLevel user — Setup → Users" (page and emails).

## Not verified by Claude (nothing live was sent)

- No email was sent: Resend is not configured in this environment and no scheduled run happened on the new code.
- The retry button on the real tenant (no partial log exists there yet — stage 2's dry run is still on).
- The `Send test to me` path end to end (needs Resend + a personal login).
- The screenshots are the demo tenant; the real-tenant previews were read in text (the HTML sits in the scratch
  folder, not in the repo).

## What Mitchell must verify by hand

1. **Deploy order:** `npm run db:migrate` FIRST (0023: `email_digests.is_test` with a default + the settings copy —
   additive, safe for the deployed code), THEN `git push`. Note: every report is **OFF** after the migration unless the
   old digest switch was stored explicitly `'true'`; the old recipients carry over.
2. **Vercel env:** `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (and `APP_URL`, the origin the emails' button points at —
   otherwise the Vercel production host is used).
3. **/reports:** per card, set the recipients (Jake; the Daily to Jake + Miranda), press **Preview**, press **Send test to
   me** from a personal login and read the email, then switch each report **On**. Watch the first scheduled sends:
   the Daily tomorrow ~12:40 am, the Weekly Sunday, the Monthly Nov 1 — the card's "Last sent" and the archive row.
4. **/onboarding:** open today (live) and yesterday (mirror); after Miranda's first real logs, check a partial row's
   Retry; Export CSV.
5. `npm run reports:preview -- --report daily --date <yesterday> --out /tmp/x` against production any time — never sends.
6. **Setup → Users:** add a test user, confirm the password stays with Copy until Done; disable the test user after.

## Open design notes

- The daily keeps the Day-1 / Day-3 / awaiting-rebook follow-ups as its last section (the brief did not list them;
  dropping Miranda's call list silently would be a regression) — say the word and they go.
- The weekly / monthly list unlogged calls as ONE count ("24 ended calls with no outcome logged this week — see the
  Onboarding page") and every failed log one by one; the daily lists each unlogged call.
- "Roadmaps booked" counts consult calls whose log lands on the roadmap_booked role; "Enrolled" any log landing on
  enrolled or a deal marked Won; "Showed" = the log's appointment status, or GHL's own when there is no log.
