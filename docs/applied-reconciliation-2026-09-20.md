# "Applied" reconciliation — week of Sep 20–26, 2026 (America/Edmonton)

Read-only investigation, 2026-09-30, at Mitchell's request. Nothing in the engine was changed; the
recommendation at the end waits for a DECISION. Every number below is traced to rows in
`docs/verification/applied-reconciliation-2026-09-20.json` (the week) and
`…-2026-08-01.json` (August), written by `scripts/reconcile-applied.ts` from live GET calls
through the app's own clients (`ghlRequest`, `metaRequest`) and the engine (`getScorecard`).

## The four numbers

| Source | Sep 20–26 | What it counts |
|---|---|---|
| Meta Ads Manager "Website Submit Applications" | **82** (34 / 38 / 10) | pixel conversion events, 7-day click + 1-day view |
| GHL opportunities created in the week, all 15 pipelines | **54** | 51 in "[new] Application Pipeline", 2 in "{ Off } Sales Funnel", 1 in "Marketing/Sales Pipeline" |
| FitFlow "Applied" today (opportunity created in a followed pipeline) | **52** | the 51 above + 1 opportunity moved in from another pipeline this week (Nuala Broadhead, dated by entry) |
| **Recommended: people who applied through the application form** | **40** | new contacts whose GHL source is the application form, opportunity created this week |

## 1. GHL form submissions — NOT VERIFIED

`GET /forms/` and `GET /forms/submissions` both return `401 "The token is not authorized for this
scope."` The Private Integration Token has no `forms.readonly` scope. Until it does, "submitted the
form" is read from the **contact's `source`**, which the GHL form sets on the contact it creates:
`New Application 7.10` (42 people this week), `Fit Physician Application` (1), `Fit Physician
Application (B)` (1). Every other source this week (Facebook, fit physician quiz, longevity &
running, facebook form lead, 15-Minute Consult, Roadmap Building Session, Back To School
Scholarship, roadmap workshop) is not an application. This is the same signal the form writes; what
it cannot give is the submission timestamp or a second submission by the same person — both need
the scope. **Ask:** add `forms.readonly` to the token in GHL → Settings → Private Integrations; the
script then fills section 1 without any other change.

## 2. Opportunities created in the week, every pipeline

One location-wide walk (`GET /opportunities/search`, 9,295 opportunities in 93 requests, all
GET). 54 were created Sep 20–26 (local date of `createdAt`):

| Pipeline | Created | Stage at read time |
|---|---|---|
| [new] Application Pipeline (followed) | 51 | Applied 30 · Pre-Roadmap Booked 7 · Enrolled 7 · Consult Booked 6 · Consult No Show 1 |
| { Off } Sales Funnel (+ Case Study) | 2 | Applied - No Call Within 30 Days |
| Marketing/Sales Pipeline | 1 | New Lead |

Status: 47 open, 7 won. By day: 20th 9 · 21st 10 · 22nd 4 · 23rd 9 · 24th 4 · 25th 3 · 26th 15.

## 3. Per person

Class: **A1** new contact via the application form · **A2** returning contact re-applied at Applied ·
**A3** pre-existing form-sourced contact entered directly into a later stage · **C** manual entry
into a later stage (non-form contact) · **D** non-form contact entered at Applied · **X** opportunity
only in an unfollowed pipeline. "First seen" is the stage FitFlow's hourly sync first observed the
opportunity in; a new applicant who books within the hour is first seen at Consult Booked, so for
NEW contacts the stage is not evidence of a manual entry — the source is.

| Person | Contact created | GHL source | utm_campaign | Opportunity (pipeline / stage · created) | First seen | Counted today | Class | Recommended |
|---|---|---|---|---|---|---|---|---|
| Diana Diaz | 2026-09-20 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-20 12:24 | Applied | yes | A1 | yes |
| Mydhili Moorthie | 2026-09-20 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-20 14:32 | Applied | yes | A1 | yes |
| Sarah Farquharson | 2026-09-20 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-20 15:18 | Applied | yes | A1 | yes |
| Doaa El Rouby | 2026-09-20 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-20 21:29 | Applied | yes | A1 | yes |
| Greta Guyer | 2026-09-21 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-21 11:05 | Applied | yes | A1 | yes |
| Michelle Farrell | 2026-09-21 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-21 11:21 | Applied | yes | A1 | yes |
| Monica Chaddock | 2026-09-21 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-21 13:34 | Applied | yes | A1 | yes |
| R Thomas | 2026-09-21 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-21 22:25 | Applied | yes | A1 | yes |
| mili kakadiya | 2026-09-21 (new) | New Application 7.10 | Profile | Application / Applied · 2026-09-21 23:26 | Applied | yes | A1 | yes |
| Janelle Hupp | 2026-09-22 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-22 20:07 | Applied | yes | A1 | yes |
| Josephine Perez | 2026-09-22 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-22 22:05 | Applied | yes | A1 | yes |
| DeeDee Price | 2026-09-23 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-23 02:52 | Applied | yes | A1 | yes |
| Josel doyle | 2026-09-23 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-23 15:41 | Applied | yes | A1 | yes |
| Sangeeta Garg | 2026-09-23 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-23 17:37 | Applied | yes | A1 | yes |
| Kelly Peesker | 2026-09-23 (new) | New Application 7.10 | (Sept 7) Testing | Application / Applied · 2026-09-23 22:22 | Applied | yes | A1 | yes |
| Roseanna Parkhurst-Gatewood | 2026-09-24 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-24 01:58 | Applied | yes | A1 | yes |
| Jenny Ogilvie | 2026-09-25 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-25 00:41 | Applied | yes | A1 | yes |
| Simin K | 2026-09-25 (new) | Fit Physician Application  | — | Application / Applied · 2026-09-25 12:37 | Applied | yes | A1 | yes |
| Tracy Moore | 2026-09-26 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-26 13:23 | Applied | yes | A1 | yes |
| Gae Rodke | 2026-09-26 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-26 17:34 | Applied | yes | A1 | yes |
| Joanne White | 2026-09-26 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-26 17:40 | Applied | yes | A1 | yes |
| Manaal Ameen | 2026-09-26 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-26 18:39 | Applied | yes | A1 | yes |
| Sharon Hird | 2026-09-26 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-26 19:50 | Applied | yes | A1 | yes |
| amy cole | 2026-09-26 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-26 23:54 | Applied | yes | A1 | yes |
| Lynn Murphy | 2026-09-27 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Applied · 2026-09-27 02:30 | Applied | yes | A1 | yes |
| Shirley Anne Thomson | 2026-09-27 (new) | New Application 7.10 | (Sept 7) Testing | Application / Applied · 2026-09-27 02:54 | Applied | yes | A1 | yes |
| Annie Kurian | 2026-09-26 (new) | New Application 7.10 | (July 16) New VSL | Application / Applied · 2026-09-27 03:24 | Applied | yes | A1 | yes |
| Nicole Coluccio | 2026-09-20 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-20 17:09 | Consult Booked | yes | A1 | yes |
| Renee Riggs | 2026-09-21 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-21 01:06 | Consult Booked | yes | A1 | yes |
| Jennifer Daniels | 2026-09-21 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-21 19:36 | Consult Booked | yes | A1 | yes |
| Teri Miner | 2026-09-26 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-26 12:23 | Consult Booked | yes | A1 | yes |
| Allison Haynes | 2026-09-26 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-26 20:25 | Consult Booked | yes | A1 | yes |
| Dzovag Minassian | 2026-09-27 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Consult Booked · 2026-09-27 03:55 | Consult Booked | yes | A1 | yes |
| Alexandra Bunting | 2026-09-24 (new) | New Application 7.10 | (July 16) New VSL | Application / Consult No Show · 2026-09-24 00:07 | Consult No Show | yes | A1 | yes |
| Heidi Thorson | 2026-09-20 (new) | New Application 7.10 | (Sept 7) Testing | Application / Enrolled · 2026-09-20 13:14 | Enrolled | yes | A1 | yes |
| Sreyoshi Alam | 2026-09-20 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Pre-Roadmap Booked · 2026-09-20 20:42 | Pre-Roadmap Booked | yes | A1 | yes |
| Magalie DUBE | 2026-09-22 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Pre-Roadmap Booked · 2026-09-22 05:31 | Pre-Roadmap Booked | yes | A1 | yes |
| Elizabeth Dickens | 2026-09-23 (new) | New Application 7.10 | (Sept 7) Scaling | Application / Pre-Roadmap Booked · 2026-09-23 23:28 | Pre-Roadmap Booked | yes | A1 | yes |
| Seema Menon | 2026-09-24 (new) | New Application 7.10 | (Sept 7) Testing | Application / Pre-Roadmap Booked · 2026-09-24 14:38 | Pre-Roadmap Booked | yes | A1 | yes |
| Lori Reed | 2026-09-27 (new) | New Application 7.10 | (July 16) New VSL | Application / Pre-Roadmap Booked · 2026-09-27 00:13 | Pre-Roadmap Booked | yes | A1 | yes |
| Marion Raflores | 2025-07-27 (pre-existing) | New Application 7.10 | — | Application / Pre-Roadmap Booked · 2026-09-24 20:06 | Pre-Roadmap Booked | yes | A3 | no |
| Mireille Desrosiers | 2024-11-25 (pre-existing) | fit physician roadmap workshop | — | Application / Enrolled · 2026-09-22 14:30 | Enrolled | yes | C | no |
| Lindsay Ritsma | 2025-05-21 (pre-existing) | longevity & running | — | Application / Enrolled · 2026-09-23 22:31 | Enrolled | yes | C | no |
| Jen Clow | 2024-11-25 (pre-existing) | Back To School 2026 Scholarship | — | Application / Enrolled · 2026-09-23 22:32 | Enrolled | yes | C | no |
| Paula Edelson | 2025-10-12 (pre-existing) | 15-Minute Fit Physician Consult | — | Application / Enrolled · 2026-09-24 00:42 | Pre-Roadmap Booked | yes | C | no |
| Alanna Roberts | 2024-11-25 (pre-existing) | Internal: Roadmap Building Session | — | Application / Enrolled · 2026-09-25 15:30 | Enrolled | yes | C | no |
| Catherine Turcot | 2024-11-25 (pre-existing) | longevity & running | — | Application / Enrolled · 2026-09-25 23:04 | Enrolled | yes | C | no |
| Sara Rasmussen | 2024-11-25 (pre-existing) | facebook form lead | — | Application / Pre-Roadmap Booked · 2026-09-26 11:10 | Pre-Roadmap Booked | yes | C | no |
| Karan VOLLMANN | 2025-07-03 (pre-existing) | Facebook | — | Application / Applied · 2026-09-21 14:16 | Applied | yes | D | no |
| Molly O’Connor | 2025-07-31 (pre-existing) | fit physician quiz | TH | TOF Quiz | Application / Applied · 2026-09-24 18:27 | Applied | yes | D | no |
| Morgan Wimberley | 2024-11-25 (pre-existing) | Facebook | — | Application / Applied · 2026-09-27 00:32 | Applied | yes | D | no |
| Erin FitzPatrick | 2026-09-20 (new) | Fit Physician Application (B) | — | Marketing/Sales Pipeline / New Lead · 2026-09-20 11:49 | — | NO — opportunity only in "Marketing/Sales Pipeline" (not followed) | X | no |
| Suzan Abdel Salam | 2024-11-25 (pre-existing) | New Application 7.10 | — | { Off }  Sales Funnel (+ Case Study) / Applied - No Call Within 30 Days  · 2026-09-21 16:48 | — | NO — opportunity only in "{ Off }  Sales Funnel (+ Case Study)" (not followed) | X | no |
| Lisa Brinn | 2026-09-17 (pre-existing) | New Application 7.10 | — | { Off }  Sales Funnel (+ Case Study) / Applied - No Call Within 30 Days  · 2026-09-21 16:49 | — | NO — opportunity only in "{ Off }  Sales Funnel (+ Case Study)" (not followed) | X | no |

Not among the 54 but counted today: **Nuala Broadhead** — her opportunity was first seen in another
pipeline and entered the followed pipeline this week (`appliedFromMove: 1`); not verified whether she
submitted the form. One followed-pipeline contact (Jacob) has no opportunity record and is in the
data-health banner, not in Applied.

Everyone who applied but is not counted: **Erin FitzPatrick** (form source, opportunity only in
Marketing/Sales Pipeline), **Suzan Abdel Salam** and **Lisa Brinn** (form source, opportunity only in
"{ Off } Sales Funnel"). Three people, all because their opportunity is in an unfollowed pipeline.

Counted today but not applications: the 7 **C** rows (6 pre-existing contacts created straight into
Enrolled, 1 into Pre-Roadmap Booked — Miranda's manual entries), the 3 **D** rows (Karan Vollmann and
Morgan Wimberley, Facebook contacts from 2025/2024; Molly O'Connor, quiz contact — entered at Applied
with no form submission signal) and 1 **A3** (Marion Raflores, a 2025 form contact created straight
into Pre-Roadmap Booked). 11 of the 52.

## 4. Meta

`GET /act_…/insights?level=campaign&fields=conversions,unique_conversions` for Sep 20–26. Ads
Manager's "Website Submit Applications" is the `conversions` field's `submit_application_website`
action (the pixel's custom events aggregate under `actions` as `offsite_conversion.fb_pixel_custom`
— 43 / 53 / 15 — and are a different thing).

| Campaign | submit_application_website | 7d click | 1d view | unique_conversions |
|---|---|---|---|---|
| (July 16) New VSL | 34 | 32 | 2 | not returned |
| (Sept 7) Scaling | 38 | 38 | 0 | not returned |
| (Sept 7) Testing | 10 | 10 | 0 | not returned |

- **Report time makes no difference**: `action_report_time=conversion` and `=impression` both give
  34 / 38 / 10 = 82. **Attribution window makes no difference**: 7d_click+1d_view, 7d_click alone
  and 1d_click alone all give 82 (every click conversion happened within a day of the click; only 2
  are view-through). So neither the date basis nor view-through explains the gap.
- **`unique_conversions` is not returned** for this action (the API gives it only for `link_click`).
  Whether the 82 are 82 people cannot be read from the API — NOT VERIFIED. Events Manager's
  "deduplicated" view for the SubmitApplication / "Congrats2" event is the place to check.
- Per campaign, Meta counts about twice what FitFlow tracks to the same campaign, and the ratio is
  similar across all three:

| Campaign | Meta submits | FitFlow counted with this utm | of which A1 (form applicants) | Meta ÷ A1 |
|---|---|---|---|---|
| (Sept 7) Scaling | 38 | 19 | 19 | 2.0 |
| (July 16) New VSL | 34 | 15 | 15 | 2.27 |
| (Sept 7) Testing | 10 | 4 | 4 | 2.5 |

- Per day (Meta in the ad account's Pacific day; GHL and A1 by the Edmonton date the opportunity was created):

| Day | Meta submits | GHL opps created (Application pipeline) | A1 applicants |
|---|---|---|---|
| 2026-09-20 | 14 | 8 | 8 |
| 2026-09-21 | 14 | 8 | 7 |
| 2026-09-22 | 6 | 4 | 3 |
| 2026-09-23 | 12 | 9 | 6 |
| 2026-09-24 | 8 | 4 | 2 |
| 2026-09-25 | 0 | 3 | 1 |
| 2026-09-26 | 28 | 15 | 13 |

**Reading the gap (82 vs 40 form applicants; 82 vs 44 if the three in unfollowed pipelines are
included).** A near-constant ~2× across campaigns, on every window and report basis, is the
signature of the event firing about twice per application — not of people missing from GHL (that
would vary by campaign) and not of attribution (the windows agree). What the account defines (read
from `/customconversions`): **"Congrats2"** (id 1880984695928550, type SUBMIT_APPLICATION) is the
pixel's `SubmitApplication` event *when the URL contains `thefitphysician.com/congrats2`*, and
**"New Submit App"** (id 24822613537419285, type OTHER) is a `PageView` of `/congrats`. So the
"Website Submit Applications" column counts SubmitApplication events fired on the congrats2 page: a
page that fires the event on load counts every load (refresh, back, a second visit, a redirect
through it), and a browser pixel plus Conversions API without a shared `event_id` counts each
submission twice. Sep 25 (Meta 0) is consistent: the day's one real application (Simin K, source
"Fit Physician Application", no utm) was not from an ad; the other two Sep 25 rows are manual
Enrolled entries. **Which of the two double-counts it is cannot be verified from the API** — Events
Manager (event count vs deduplicated for SubmitApplication, and whether both a pixel and a server
event arrive) will say; I did not open it.

## 5. Recommended definition of Applied (DECISION needed — nothing changed yet)

**Applied = a person who submitted the application form in the period, counted once per period,
dated by the submission.** Concretely, until the forms scope exists: an opportunity created in a
followed pipeline in the period whose contact's GHL `source` is one of the application forms, plus
a returning contact who re-applied (form source, entered at Applied). Excluded: opportunities
created for contacts whose source is not the application form (manual entries into Enrolled /
Pre-Roadmap Booked / Consult No Show, re-engaged Facebook or quiz leads entered at Applied), and
form-sourced pre-existing contacts entered directly into a later stage (a re-import, not a new
application). Applications in an unfollowed pipeline stay excluded (3 this week) but are named in
data health, as the banner already does for missing dates. With `forms.readonly` the same
definition reads the submission record directly and gains the timestamp and the duplicate-submission
count.

| Period | Today (opportunity created in a followed pipeline) | Recommended | Meta |
|---|---|---|---|
| Sep 20–26 | 52 | **40** (A1 40 + A2 0) | 82 |
| August 1–31 | 221 (opportunities created in the two followed pipelines: Application 186, Miranda Pipeline (July) 70, minus unfollowed/undated) | **130** (A1 125 + A2 5) | not pulled |

August by class (all 247 opportunities created in August across every pipeline; 221 counted
today): A1 125 · A2 5 · A3 41 · C 38 · D 19 · X 19. The A3 rows are mostly contacts imported on
2024-11-25 and placed straight into Consult No Show / Consult Booked in August — a pipeline
migration when "[new] Application Pipeline" was set up, not August applications. Today's 221 is
therefore inflated by ~90 rows that were never applications; the week's 52 by 12.

What changes if approved: `lib/metrics/load.ts` dates and scopes Applied by the form signal instead
of "any opportunity created in a followed pipeline"; the glossary and CLAUDE.md rule 8 say so;
Paid CAC / Blended CAC / ROAS are untouched (they use enrollments and cash); cost per lead rises
(fewer leads for the same spend: this week $9,533.67 ÷ 40 instead of ÷ 52). Manual entries into
later stages keep counting at those stages (an enrollment is still an enrollment), they just stop
being applications.

## What was not verified
- GHL form submissions (no `forms.readonly` scope): the form signal is the contact source instead.
- Whether Meta's 82 are unique people (`unique_conversions` not returned); which SubmitApplication
  source double-fires (Events Manager, not opened).
- Nuala Broadhead's application (moved-in opportunity; source not read).
- Meta's August count (not pulled — the question was the week).
- Contact `dateAdded` is UTC from GHL; two "new" contacts show 2026-09-27 for a Sep 26 evening
  application, which is the same event in Edmonton time.
