# Onboarding Companion — Stage 5 report (2026-10-30): stop side-effect emails to clients

Plan: `docs/plan-companion-stage5.md`. Nine commits on `main` after stage 4's `96f4f71`, NOT pushed; `npm run check`
green on the committed tree (see "Numbers"). The write path keeps its allow-list and its three calls — nothing here adds
a GoHighLevel write; the new GHL calls are reads (`getAppointment`, `listContactConversations`,
`listConversationMessages` — GET, through the read-only client), and `scripts/verify-readonly.sh` passes unchanged on a
clean checkout of HEAD. Items 5 (the appointment status switch) and 6 (match a manual drag) were added by Mitchell
mid-build and are included.

## Commits (oldest first)

| commit | item |
|---|---|
| `5b3f3d8` | 0 — the plan, with the root cause |
| `11b9a11` | 1 — a Reschedule never cancels (default `leave`, migration 0024, Setup label, footer "appointment unchanged") |
| `7e0b034` | 2 — never re-save a stage: plan + confirm from the LIVE opportunity and appointment; `lib/companion/decide.ts`; backward rule |
| `68c0120` | 3 — say what GHL will do: the plan's own footer line, the automation note, Setup's per-outcome note |
| `728bd38` | 5 — the appointment status switch (default OFF) |
| `e746fa8` | 4 — `npm run companion:audit` |
| `540686f` | report — footer line wraps instead of truncating, screenshots, the first version of this report, CLAUDE.md |
| `cd880e7` | 6 — match a manual drag: minimal PUT body, the "no change" guard, `npm run companion:parity` |
| (item 7) | 7 — this report updated for item 6, the plan, CLAUDE.md |

## 1. Root cause of the same-stage PUT (Bridget Voigt, 2026-10-30 12:27:39 MDT)

Live row `6a57d161` (`companion_actions`, `created_at 2026-10-30T18:27:39.190Z`): `before` = `after` = Pre-Roadmap Booked /
open; stage step `ok`, request `PUT /opportunities/jdC9CKdIEVEjtKo19JQl { pipelineId, pipelineStageId: e1b9fbb8… }`,
HTTP 200. Its note text reads "Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)" — the plan believed she was
in Consult Booked (the mirror) while the live read, written into `before`, said Pre-Roadmap Booked.

The code path, in `lib/companion/log.ts` as shipped at `96f4f71` (stage 2's `executeLog`):

1. **`lib/companion/log.ts:270`** — `const planned = await planLog(input, deps)`: `planLog` built `plan.steps` from the
   MIRROR (`readContactPosition` → `ghl_opportunities`, refreshed hourly at :07). GHL had moved Bridget to Pre-Roadmap
   Booked when the roadmap was booked ~2 minutes earlier; the mirror still said Consult Booked, so the stage step got a
   request `pipelineStageId = Pre-Roadmap Booked`.
2. **`lib/companion/log.ts:274–283`** — the live re-read found `pipelineStageId` = Pre-Roadmap Booked ≠
   `expectedStageId` (Consult Booked, the plan's own mirror value) → 409 "Stage changed to Pre-Roadmap Booked since you
   opened this — continue?". Miranda pressed *Continue anyway* → the client resent with `acceptedStageId` = Pre-Roadmap
   Booked → the check passed.
3. **`lib/companion/log.ts:285`** — `if (liveStage !== plan.before.stageId) plan.before = { …live }` rewrote `before`
   (and `after` only for an outcome with no stage) — but **`plan.steps` was never recomputed**.
4. **`lib/companion/log.ts:296–297`** — `for (const s of plan.steps) steps[s.name] = … { request: s.request }` copied the
   stale request into the row, and `runSteps` sent it: a PUT to the stage she was already in.

Lara Kujtan (Oct 29) and Jacob Wright (Oct 30 08:15) differed only in timing: an hourly sync had landed between the
booking and the log, the mirror already said Pre-Roadmap Booked, and `planLog` itself skipped the step ("already in
Pre-Roadmap Booked"). The decision came from the brief cache; only the record came from the live read.

**The fix (item 2, `7e0b034`).** `planLog` now reads the opportunity (`getOpportunity`) and the appointment (new
read-only `getAppointment`) LIVE before any decision; `before`, the stage step, the appointment step and the note text
all come from that read. `executeLog` calls `planLog` (so the read immediately precedes the write), keeps the 409
prompt (live stage ≠ expected ≠ accepted) and no longer rewrites anything — the decisions are the pure
`lib/companion/decide.ts`:

- `decideStage`: live stage AND status already equal the target → skipped `already in <stage>`; a mapped outcome whose
  target sits EARLIER in the pipeline order (`stages.position`) than the live stage → skipped `already past <target> (in
  <current>)`; only "Move to…" may go backward, and is marked (`backward`, the line reads "Moves back to …"); a live stage
  with no known position is not judged.
- `decideAppointment`: the Setup switch off → skipped `appointment updates are off in Setup` (item 5); the outcome leaves
  it → `left as is`; the live status already equals the target → skipped `already <status>`; else the PUT.

Regression tests in `tests/companion-log.test.ts`: Bridget's exact case through the 409 → *Continue anyway* path (mirror
Consult Booked, live Pre-Roadmap Booked → stage step `skipped · already in Pre-Roadmap Booked`, writes = appointment PUT
+ note POST, no transition) and through a fresh plan (expected = live → no 409, still skipped); "already past" (live
Enrolled, outcome roadmap booked → skipped, the appointment still lands; Move to Consult Booked from Enrolled sends and
is marked backward); the appointment already `showed` → no PUT; an unreadable appointment → 502 while the switch is on.

**Runtime evidence (rule 7).** `GET /calendars/events/appointments/{eventId}` answers `{ appointment: { …,
appointmentStatus, appoinmentStatus (sic), … }, traceId }` — the docs call the key `event`. Probed once read-only on
Bridget's event on 2026-10-30; `lib/ghl/schemas.ts#GhlAppointmentByIdResponseSchema` reads `appointment`.

## 2. What was built, and what it looks like

**Item 1 — Reschedule never cancels.** `RESCHEDULE_APPOINTMENT_DEFAULT = 'leave'`; `rescheduleAppointmentOf` cancels only
on the literal `'cancelled'`. Migration `0024_companion_reschedule_leave.sql`: no row → INSERT `'leave'`; a stored
`'cancelled'` (a human's choice in Setup — the only way a row exists) → kept, `RAISE NOTICE 'companion_reschedule_appointment
is ''cancelled'' (set by the owner in Setup) — kept; …'`; `'leave'` → nothing. Setup → Companion: "Reschedule → leave the
appointment as is (default)" / "Reschedule → cancel the appointment (GHL may email the client)". Footer for Reschedule:
"Moves to Consult Reschedule · appointment unchanged · adds note" (screenshots below).

**Item 3 — say what GHL will do.** The confirm-phase footer line is `plan.effectLine`, built by
`popoutState#planEffectLine` from the plan's STEPS: a skipped step is omitted ("Marks showed · adds note" for Bridget's
situation; "Adds note" when everything already matches), a left-alone appointment reads "appointment unchanged", a
backward Move to reads "Moves back to X". A second 11 px line "GHL automations on appointment status may message the
client." appears in the pick and confirm phases whenever the appointment status would change, and on Setup's outcome map
per outcome (effective appointment after the Reschedule rule; "not sent while updates are off" while item 5's switch is
off). The footer line wraps to two lines instead of truncating (item 6) — the 360×560 no-scroll assertion still holds for
every state.

**Item 5 — the appointment status switch.** `settings.companion_appointment_updates`: only the literal `'true'` turns it on;
missing / malformed = OFF. Setup → Companion: "Update appointment status in GoHighLevel" with the toggle and the warning
"Turn on only after GHL workflows that trigger on appointment status filter to Confirmed/Booked." While off, every
outcome's appointment step is `skipped · appointment updates are off in Setup`, the stage and the note still go, the pop-out
footer reads "appointment unchanged" (the pick phase too: `useOutcomeLog` maps every effect to `leave`), and an unreadable
appointment no longer blocks the log (`before.appointmentStatus` is recorded null). `PATCH /api/setup/companion
{ appointmentUpdates: boolean }`. Tests: OFF → no `/calendars/` PUT for every outcome the fixture can resolve (5 Consult +
2 Roadmap), the note always goes; ON → the suite's existing behaviour.

**Item 4 — the audit.** `npm run companion:audit -- --days 7` (`scripts/companion-audit.ts`, read-only, database only):
every row of the window with each step's request; flags (a) SAME-STAGE PUT (`pipelineStageId` = `before.stageId`),
(b) APPOINTMENT CANCELLED, (c) BACKWARD MOVE (by `stages.position`); an unsent request is "(planned, not sent)".
`auditFlags` is pure and tested on Bridget's / Sindhu's shapes. Exit 0 always.

**Item 6 — match a manual drag.** Evidence: Bridget's same-stage PUT at 12:27 MDT was followed at 12:28 by GHL re-sending
her Oct 24 consult-confirmation set; Lara, whose stage step was skipped, got nothing. A person dragging a card never
re-saves the current stage, so FitFlow must not either:

- `lib/companion/patch.ts#minimalOpportunityPatch` (pure): the body carries ONLY what changes — `pipelineStageId` when
  the stage changes, `status` when the status changes, `pipelineId` only when the opportunity's pipeline differs from
  the followed one. `decideStage` builds every stage request through it.
- `ghlWrite#updateOpportunity(id, patch, { dryRun, live })` drops fields equal to `live` and refuses a body left empty
  BEFORE any I/O: `{ status: 'skipped', reason: 'no change' }` — the log records the step as skipped, the row is still
  `ok`. `updateAppointmentStatus` the same against the live appointment status. The log passes the row's `before` (the
  live read the plan was made from) as `live`; undo passes `after` and restores with the same minimal rule.
- `tests/companion-write.test.ts`: the minimal body `{ pipelineStageId }` passes to the transport as is; the pipeline
  id of the pipeline it is already in and the status it already has are dropped; another pipeline → `pipelineId`
  travels with the stage; Bridget's body never reaches the transport (`skipped` / `no change`, `fetch` not called); the
  same for an appointment already at the status.

**The exact request bodies FitFlow sends now, per outcome** (the followed pipeline's stage ids resolved by ROLE at
log time; the appointment PUT only while the Setup switch is ON and the live status differs; the note POST always;
nothing at all for a field GHL already holds):

| outcome | PUT /opportunities/{id} body | PUT /calendars/events/appointments/{eventId} body (switch ON) |
|---|---|---|
| Consult · Showed, roadmap booked | `{"pipelineStageId":"<roadmap_booked>"}` — skipped when already there / past it | `{"appointmentStatus":"showed"}` |
| Consult · No-show | `{"pipelineStageId":"<consult_noshow>"}` | `{"appointmentStatus":"noshow"}` |
| Consult · Reschedule | `{"pipelineStageId":"<consult_rescheduled>"}` | none (rule `leave`) |
| Consult · Cancelled | none (stage unchanged, status already open) | `{"appointmentStatus":"cancelled"}` |
| Consult · Not a fit | `{"status":"lost"}` | `{"appointmentStatus":"showed"}` |
| Roadmap · Enrolled | `{"pipelineStageId":"<enrolled>","status":"won"}` | `{"appointmentStatus":"showed"}` |
| Roadmap · Showed, objection | `{"pipelineStageId":"<roadmap_showed>"}` | `{"appointmentStatus":"showed"}` |
| Roadmap · No-show | `{"pipelineStageId":"<roadmap_noshow>"}` | `{"appointmentStatus":"noshow"}` |
| Roadmap · Reschedule | `{"pipelineStageId":"<roadmap_rescheduled>"}` | none (rule `leave`) |
| Roadmap · Not a fit | `{"status":"lost"}` | `{"appointmentStatus":"showed"}` |
| Move to… X (+ appointment choice) | `{"pipelineStageId":"<X>"}` (may go backward) | the chosen status, or none |
| undo | `{"pipelineStageId":"<before>"}` (+ `"status"` only when the log changed it) | `before.appointmentStatus` only when the log changed it |

`pipelineId` is added only when GHL reports the opportunity in a pipeline other than the followed one. Stage 2's note
said "GHL requires pipelineId in the body"; that came from the docs (which mark it required on the update body), not from
a live response. If GHL rejects a body without it, the parity run shows the 4xx on the stage step with GHL's message and
the one-line fix is to keep `pipelineId` in `minimalOpportunityPatch` — the guard against a no-op body stands either way.

**`npm run companion:parity`** (`scripts/companion-parity.ts`): refuses without `--i-understand-this-writes`, without a
write key, for a contact whose name lacks "test" (case-insensitive — `isTestContactName`, tested), or without an
opportunity in the followed pipeline. Dry run is forced OFF through `executeLog`'s `deps.dryRun` for this process only;
the saved setting is printed and never changed. Per outcome: live read → `executeLog` (the real path) → wait `--wait`
(90 s) → every OUTBOUND message GHL logged for the contact in the window, via the read-only `/conversations/search` and
`/conversations/{id}/messages` (time · channel · subject / first line · `source` · any `workflow*` key GHL carries) →
restore with a minimal PUT (printed as a move that may trigger the start stage's automations; its own window listed)
→ the table outcome → requests → messages; exit 1 on any no-op body. **Not run by Claude** (it writes to GHL, and the
production read key answered 401 on `/conversations/search` on 2026-10-30 — it lacks `conversations.readonly` +
`conversations/message.readonly`; the script names that in the messages column; the conversation schemas are lenient
and documented-shape only until the scopes exist).

**Parity table — for Mitchell to fill after running the script against Jake's test contact:**

| outcome | requests sent (method path body → status) | messages GHL sent in 90 s | after the restore |
|---|---|---|---|
| consult_showed_booked | | | |
| consult_noshow | | | |
| consult_reschedule | | | |
| consult_cancelled | | | |
| consult_not_fit | | | |
| roadmap_enrolled | | | |
| roadmap_showed_objection | | | |
| roadmap_noshow | | | |
| roadmap_reschedule | | | |
| roadmap_not_fit | | | |

Expected: no row carries a NO-OP body (the script exits 1 otherwise); a mapped move's messages are that stage's own
automations (intended); nothing re-sends a consult confirmation for a stage the contact already had.

## 3. Audit output (production database, read-only, 2026-10-30)

```
Companion audit · last 7 day(s) since 2026-10-23T20:05:05.101Z · 7 action(s) · read-only

  Oct 28, 11:53 AM America/Edmonton · Miranda · Jacob · Consult · No-show (consult_noshow) · dry_run · DRY RUN
    before — / — / appt confirmed  →  after Consult No Show / open / appt noshow
    stage       skipped — no opportunity in [new] Application Pipeline (no request)
    appointment dry run — not sent                           PUT /calendars/events/appointments/YZrYZtIWYovZOGEd25nF {"appointmentStatus":"noshow"}
    note        dry run — not sent                           POST /contacts/rdSAJrk3AHkn5rt6665q/notes {"body":"Onboarding call · Consult · Oct 28, 12:00 PM · Miranda\nOutcome: No-show (no stage → Consult No Show)\nNote: No show today","userId":"gUYW4bOBKjgrgFCBAW6W"}

⚑ Oct 28, 12:01 PM America/Edmonton · Miranda · Jacob · Roadmap · Reschedule (roadmap_reschedule) · partial
    before — / — / appt confirmed  →  after Roadmap Reschedule / open / appt cancelled
    stage       skipped — no opportunity in [new] Application Pipeline (no request)
    appointment ok HTTP 200                                  PUT /calendars/events/appointments/2w3AQ07us0b3rUizlAZr {"appointmentStatus":"cancelled"}
    note        failed HTTP 401 — GHL 401 POST /contacts/rdSAJrk3AHkn5rt6665q/notes: {"statusCode":401,"message":"The token is not authorized for this scope."} POST /contacts/rdSAJrk3AHkn5rt6665q/notes {"body":"Onboarding call · Roadmap · Oct 28, 12:00 PM · Miranda\nOutcome: Reschedule (no stage → Roadmap Reschedule)\nNote: Agreed - ..","userId":"gUYW4bOBKjgrgFCBAW6W"}
    ⚑ APPOINTMENT CANCELLED — PUT /calendars/events/appointments/2w3AQ07us0b3rUizlAZr appointmentStatus=cancelled (was confirmed)

⚑ Oct 28, 12:10 PM America/Edmonton · Miranda · Kristin Kreider · Roadmap · Reschedule (roadmap_reschedule) · failed
    before Pre-Roadmap Booked / open / appt confirmed  →  after Roadmap Reschedule / open / appt cancelled
    stage       failed HTTP 401 — GHL 401 PUT /opportunities/pMGs6Qz2z9Snzf1y0t6g: {"statusCode":401,"message":"The token is not authorized for this scope."} PUT /opportunities/pMGs6Qz2z9Snzf1y0t6g {"pipelineId":"UR5P3vNTm9VPuYZFrb6c","pipelineStageId":"e046ab13-31f7-49dd-a0f9-48f7dbc61cb6"}
    appointment pending — not sent                           PUT /calendars/events/appointments/8wAOp8G5NeepYbBy4wg8 {"appointmentStatus":"cancelled"}
    note        pending — not sent                           POST /contacts/QN9jDvqeFYU1x45ZYBbm/notes {"body":"Onboarding call · Roadmap · Oct 28, 4:00 PM · Miranda\nOutcome: Reschedule (Pre-Roadmap Booked → Roadmap Reschedule)\nNote: Something came up","userId":"gUYW4bOBKjgrgFCBAW6W"}
    ⚑ APPOINTMENT CANCELLED (planned, not sent) — PUT /calendars/events/appointments/8wAOp8G5NeepYbBy4wg8 appointmentStatus=cancelled (was confirmed)

  Oct 29, 12:07 PM America/Edmonton · Miranda · Lara Kujtan · Consult · Showed, roadmap booked (consult_showed_booked) · ok
    before Pre-Roadmap Booked / open / appt confirmed  →  after Pre-Roadmap Booked / open / appt showed
    stage       skipped — already in Pre-Roadmap Booked      (no request)
    appointment ok HTTP 200                                  PUT /calendars/events/appointments/wPillJJykb51bTG0hU0O {"appointmentStatus":"showed"}
    note        ok HTTP 201                                  POST /contacts/fkbhZbPBw37ckQF7bu26/notes {"body":"Onboarding call · Consult · Oct 29, 12:00 PM · Miranda\nOutcome: Showed, roadmap booked (Pre-Roadmap Booked, unchanged)\nNote: Mom of two, struggling with consistency","userId":"gUYW4bOBKjgrgFCBAW6W"}

  Oct 30, 8:15 AM America/Edmonton · Miranda · Jacob Wright · Consult · Showed, roadmap booked (consult_showed_booked) · ok
    before Pre-Roadmap Booked / open / appt confirmed  →  after Pre-Roadmap Booked / open / appt showed
    stage       skipped — already in Pre-Roadmap Booked      (no request)
    appointment ok HTTP 200                                  PUT /calendars/events/appointments/5K1K0OfwnALuEttcozyA {"appointmentStatus":"showed"}
    note        ok HTTP 201                                  POST /contacts/rdSAJrk3AHkn5rt6665q/notes {"body":"Onboarding call · Consult · Oct 30, 8:15 AM · Miranda\nOutcome: Showed, roadmap booked (Pre-Roadmap Booked, unchanged)\nNote: Jake Booked roadmap","userId":"gUYW4bOBKjgrgFCBAW6W"}

⚑ Oct 30, 11:05 AM America/Edmonton · Miranda · Sindhu Gollamudi · Consult · Reschedule (consult_reschedule) · ok
    before Applied / open / appt confirmed  →  after Consult Reschedule / open / appt cancelled
    stage       ok HTTP 200                                  PUT /opportunities/Dj0PgX78XS3mYmcmfhn6 {"pipelineId":"UR5P3vNTm9VPuYZFrb6c","pipelineStageId":"23fb483f-9206-4ea3-a816-80184ea27cd3"}
    appointment ok HTTP 200                                  PUT /calendars/events/appointments/J3L67iQqy3ihrEkVOp3o {"appointmentStatus":"cancelled"}
    note        ok HTTP 201                                  POST /contacts/h03MbtVUBATbbxsVly72/notes {"body":"Onboarding call · Consult · Oct 30, 11:00 AM · Miranda\nOutcome: Reschedule (Applied → Consult Reschedule)\nNote: Answered, reschedule to next week","userId":"gUYW4bOBKjgrgFCBAW6W"}
    ⚑ APPOINTMENT CANCELLED — PUT /calendars/events/appointments/J3L67iQqy3ihrEkVOp3o appointmentStatus=cancelled (was confirmed)

⚑ Oct 30, 12:27 PM America/Edmonton · Miranda · Bridget Voigt · Consult · Showed, roadmap booked (consult_showed_booked) · ok
    before Pre-Roadmap Booked / open / appt confirmed  →  after Pre-Roadmap Booked / open / appt showed
    stage       ok HTTP 200                                  PUT /opportunities/jdC9CKdIEVEjtKo19JQl {"pipelineId":"UR5P3vNTm9VPuYZFrb6c","pipelineStageId":"e1b9fbb8-bd30-4b28-9545-27ea5d565bb8"}
    appointment ok HTTP 200                                  PUT /calendars/events/appointments/T2uyVAMXz6pbrq8FhUL2 {"appointmentStatus":"showed"}
    note        ok HTTP 201                                  POST /contacts/K5eOdgPjXkHBsYFI6vZF/notes {"body":"Onboarding call · Consult · Oct 30, 12:15 PM · Miranda\nOutcome: Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)\nNote: Chicago, Peds, struggling post menopause","userId":"gUYW4bOBKjgrgFCBAW6W"}
    ⚑ SAME-STAGE PUT — PUT /opportunities/jdC9CKdIEVEjtKo19JQl pipelineStageId=e1b9fbb8-bd30-4b28-9545-27ea5d565bb8 while before.stageId was the same (Pre-Roadmap Booked)

7 action(s), 4 flagged · same-stage PUT 1 · appointment cancelled 3 · backward move 0
```

It flags Bridget (SAME-STAGE PUT) and Sindhu (APPOINTMENT CANCELLED), plus two more cancels the old default produced:
Jacob's Oct 28 Roadmap reschedule (sent; the note then failed on the write key's missing scope) and Kristin Kreider's
(planned, never sent — the stage step failed 401 first). No backward move.

## 4. Settings on production (read-only, as the committed code reads them)

```
live reschedule = leave | appointmentUpdates = false
stored rows: null / null
```

No `companion_reschedule_appointment` row has ever been stored on production (the old `'cancelled'` was the CODE
default), so the committed code already reads **`leave`**; migration 0024 will write the explicit `leave` row when
Mitchell runs `npm run db:migrate`. `companion_appointment_updates` has no row → **OFF** until Mitchell turns it on in
Setup. Both re-read from production after the build with `readRescheduleAppointment()` / `readAppointmentUpdates()`.

## 5. Screenshots (`npm run screenshots -- --companion`, demo tenant, both themes, `docs/screens/{light,dark}/`)

- `companion-popout-confirm-reschedule.png` — "Confirm: Reschedule" / **Moves to Consult Reschedule · appointment
  unchanged · adds note**, no automation line (light + dark).
- `companion-popout-confirm-roadmap-booked.png` — Bridget's situation (stage already Pre-Roadmap Booked): "Confirm: Showed,
  roadmap booked" / **Marks showed · adds note** + "GHL automations on appointment status may message the client." (light + dark).
- `companion-popout-confirm.png` — the full move: "Moves to Pre-Roadmap Booked · marks showed · adds note" + the automation line.
- `companion-setup.png` — the "Update appointment status in GoHighLevel" block with its warning (off), the Reschedule rule
  select reading "leave the appointment as is (default)", the per-outcome notes under the Appointment column.

Every pop-out shot printed "no scroll (560/560)" (collapsed 66/66).

## 6. Numbers

`npm run typecheck` clean · `vitest run`: **110 files, 1097 tests passed** · `next build` ok — on the committed tree at `cd880e7`
(item 6 included; 2026-10-30). Stage 5 tests: `tests/companion-stage5.test.ts` (9: the decisions, the switch, the minimal
patch, the audit flags, the parity script's pure guards, migration 0024's three cases), `tests/companion-log.test.ts` (+4:
the live plan, Bridget's exact case, already past / Move to back, the switch OFF for every outcome; every body
expectation is the minimal shape), `tests/companion-write.test.ts` (+1: minimal body passes, equal-to-live refused
"no change"), `tests/companion-popout.test.ts` (+1: `planEffectLine` / `automationNote`), `tests/companion-outcomes.test.ts`
updated for the new defaults.

`npm run verify:readonly` passes on a clean checkout of HEAD (8/8). In the working tree it trips step 6 on
`scripts/companion-key-probe.ts`, an UNTRACKED read-only probe of Mitchell's that imports `GHL_BASE_URL` — it predates
this stage and is not part of it; nothing in the committed tree is affected.

## 7. Not verified / for Mitchell

- Nothing was written to GoHighLevel by this stage. The live proof is `npm run companion:live-test` on the test contact
  (it exercises `executeLog` → the new live reads → the decisions), after `npm run db:migrate` (0024) and the push.
- The GHL workflow filters themselves (consult confirmation on Confirmed/Booked only) are in GoHighLevel, not here;
  the switch stays OFF until that is done.
- A contact whose opportunity the mirror has not synced yet still logs without a stage step ("no opportunity in …" —
  the opportunity ID comes from the mirror); the live search for a contact's opportunities is not in scope.
- Deploy: `npm run db:migrate` (0024, additive) THEN push; then Setup → Companion to review the Reschedule rule and the
  appointment switch.
- Item 6's live proof is `npm run companion:parity -- --contact <Jake's test contact> --i-understand-this-writes`
  after the push; add `conversations.readonly` + `conversations/message.readonly` to the read key first or the messages
  column reads "unavailable". The parity table above is empty until then.
