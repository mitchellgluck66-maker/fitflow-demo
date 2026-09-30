# Discovery: FitFlow learns a business from its own data (spec, 2026-09-30)

## Why

FitFlow will be sold to companies who connect GoHighLevel, Meta and Stripe and expect a correct
dashboard right away. On our test company (The Fit Physician), most errors came from misreading the
business, not from bad copying:
- applied = new contact;
- one pipeline = the funnel;
- attendance is recorded;
- Meta's conversions = people.

The data to get each of these right was always available. Discovery reads it, proposes the business
model with evidence and confidence, and lists the few things an owner must confirm.

**This first build is a read-only script run on Fit Physician.** It passes when, run cold, it
finds on its own everything we found by hand (the "golden findings" below). Later the same
detectors power the onboarding screen and the daily reconciliation job.

## Rules

- **Read-only.** GET requests only through the app's own clients (`ghlRequest`, `metaRequest`,
  Stripe). No database writes. `npm run verify:readonly` still passes. It changes no engine
  definition.
- **Built for any company.** Nothing specific to Fit Physician in `lib/discovery/`: no pipeline
  IDs, form names, stage names or people. Fit Physician's expected results live only in the golden
  test file.
- **Detectors are pure functions** over a fetched snapshot, so each one has fixture tests.
  Fetching and detecting are separate steps.
- **Every finding carries:**
  - claim;
  - confidence (high / medium / low);
  - evidence (counts plus up to 10 example people or records, by name);
  - the effect on a metric ("Applied is 52; under this finding it's 43");
  - a plain-language question for the owner, with a pre-filled answer.
- **A missing permission is a finding, not a crash.** For example, "`forms.readonly` missing:
  applications inferred from contact source (medium confidence)".
- **Definition of done** (CLAUDE.md) applies.

## Command and output

`npm run discover -- [--months 12]` writes:
- `docs/discovery/<date>.json`: the full snapshot summary and findings;
- `docs/discovery/<date>.md`: the readable report, in these sections:
  1. connections and permissions;
  2. business basics;
  3. entry points;
  4. funnel map;
  5. calendars and attendance;
  6. people and identity;
  7. money and offers;
  8. ads and tracking;
  9. data-quality issues;
  10. **proposed model** (the definitions config FitFlow would use);
  11. **owner questions** (at most about 12);
  12. **golden score** (Fit Physician only).

It prints one line per detector: `PASS/FAIL/WARN <detector> · <headline> · <n evidence>`.

## Snapshot (fetch step)

- **GHL** (every pipeline, not just the followed one):
  - location settings;
  - users;
  - pipelines and stages;
  - all opportunities (opportunities/search);
  - contacts: source, attribution (first/last, utm, fbclid, attribution URL), tags, custom fields,
    date added;
  - calendars and appointments;
  - forms and form submissions, if permitted;
  - surveys, if permitted;
  - workflow names and status;
  - conversations/messages, only as timestamps for speed to lead.
- **Meta:**
  - account (currency, timezone);
  - campaigns, ad sets and ads;
  - daily insights (spend, impressions, clicks, actions and conversions by action type) with
    standard attribution windows;
  - custom conversions;
  - pixels and pixel event stats.
- **Stripe:**
  - customers;
  - charges and payment intents;
  - invoices and subscriptions;
  - products and prices;
  - refunds and disputes.
- Stage history comes from FitFlow's own transitions table where available. Anything the APIs
  can't give is marked NOT AVAILABLE in the report.

## Detectors

Each detector states Works / Fails / Verify in its own tests.

1. **Business basics:**
   - business timezone (from GHL location), confirmed against when activity happens by hour;
   - reporting currency;
   - Meta account currency and timezone;
   - Stripe currencies in use.
2. **Entry points:**
   - Each form or contact source: how many contacts it created, what share got an opportunity, in
     which pipeline and entry stage, and how fast.
   - Classify each source as application / lead magnet / booking / manual / import / other.
   - A bulk import shows up as many contacts created at the same timestamp.
3. **Pipelines:**
   - active vs inactive (from recent created and moved counts, and names like "Off");
   - the primary sales pipeline;
   - **applicants routed to an inactive or non-primary pipeline**, named.
4. **Funnel map:**
   - Build the stage-to-stage flow from history to get the typical order, skip patterns, won and
     lost stages, and no-show / reschedule / parked stages.
   - Propose a role for each stage (the same role set as `stages.semantic_role`) with confidence.
   - Compare the proposal with the current mapping and list the differences.
5. **Manual entries:** opportunities created directly into a late stage, especially for contacts
   that existed long before. Name them, and give the count per period and the effect on Applied
   and Enrollments.
6. **Calendars and attendance:**
   - Match each calendar to a stage role (consult, roadmap, check-in) from which contacts book it
     and when.
   - Attendance coverage: the share of past appointments marked showed or no-show.
   - Whether no-shows are recorded by stage instead.
7. **People and identity:**
   - duplicate contacts (same email or phone);
   - returning applicants;
   - the proposed "one person" rule, and the count of people vs records.
8. **Applications (the "applied" definition):** combine 2, 3, 5 and 7 to propose "applied = …",
   and give the weekly and monthly counts under the current definition and the proposed one.
9. **Money and offers:**
   - Match Stripe customers to contacts; report the match rate and unmatched amount.
   - Split initial from recurring.
   - Failed payments by invoice, later paid or not.
   - **Infer offers from payment patterns** per client (up-front amount, count × amount ×
     interval), clustered into offer candidates with how many clients each has.
   - New clients with no deal value in GHL.
10. **Ads and tracking:**
    - Custom conversion and pixel event definitions.
    - Per campaign per day: Meta conversions vs CRM applicants with that campaign tag. Report the
      ratio and its stability; a steady ratio near 2 or higher is flagged as a likely double-fire,
      with the likely causes.
    - Share of ad-driven contacts that carry a campaign tag, and where it's stored (utm fields vs
      attribution URL).
11. **Data quality:** one list of everything above that skews a metric, with names and the
    effect on the number.
12. **Proposed model and owner questions:**
    - The definitions config FitFlow would run with.
    - At most about 12 questions, each with a pre-filled answer, the evidence, and the effect on
      the numbers.
    - A "reality check" list of 3 numbers to ask the owner (e.g. clients enrolled last month).

## Golden findings: Fit Physician (tests/golden/fit-physician.discovery.json)

Discovery must reach each of these unaided. Score = found / total; target 100%.

1. Business timezone America/Edmonton; the Meta account is CAD and America/Los_Angeles; Stripe
   has CAD and USD.
2. "[new] Application Pipeline" is the primary sales pipeline; "{ Off } Sales Funnel" is
   inactive but still receiving applications.
3. The application sources are "New Application 7.10", "Fit Physician Application" and "Fit
   Physician Application (B)". Other sources (quiz, longevity & running, roadmap workshop,
   scholarship, 15-minute consult, Facebook form lead) are not applications.
4. Sep 20–26: about 40 new form applicants in the primary pipeline, plus 3 routed elsewhere (Erin
   FitzPatrick → Marketing/Sales Pipeline; Suzan Abdel Salam and Lisa Brinn → "{ Off } Sales
   Funnel"). About 12 counted opportunities that aren't applications (manual entries into
   Enrolled / Pre-Roadmap Booked, and non-form contacts entered at Applied). Matches
   docs/applied-reconciliation-2026-09-20.md.
5. Stage roles match the current mapping for the 11 active stages, including Previous Leads as
   parked and Previous Enrollments as other.
6. Attendance is recorded for about 13% of consults; no-shows are recorded by stage. A show rate
   from appointment status is not usable.
7. Campaign tags live mostly in the attribution URL, not the utm fields.
8. Meta "Congrats2" (SubmitApplication on /congrats2) runs about 2.0–2.5× the form applicants in
   every campaign: flagged as a likely double-fire.
9. New clients missing a GHL deal value, named (e.g. Tanny Raju, Jennifer Swainson, Caitlin F.
   at the time of writing).
10. Failed-payment retries on one invoice are one failure (e.g. a $525 invoice retried 6 times,
    later paid).
11. At least 2 distinct payment-plan structures are inferred as offer candidates, each with a
    client count. The exact offers are confirmed by the owner later.

Items that depend on live state (names, counts) are asserted with tolerances or "includes"
checks, not exact equality.

## Out of scope for this build

- The onboarding UI and the confirmation screen (the report's questions are the content for it).
- Any engine or definition change: those stay DECISIONs (docs/deferred.md).
- Writing to any source system.
