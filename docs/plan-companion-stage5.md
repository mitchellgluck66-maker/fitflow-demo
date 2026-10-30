# Onboarding Companion — Stage 5 plan (2026-10-30): stop side-effect emails to clients

Two live logs (Oct 29–30) made GoHighLevel message clients FitFlow never meant to touch:

- **Sindhu Gollamudi** — Consult → *Reschedule* set event `J3L67iQqy3ihrEkVOp3o` to **cancelled** (the stage 2 default
  `companion_reschedule_appointment = 'cancelled'`). GHL sent the cancel notice; the same event was then moved to Nov 3
  and re-confirmed, so she received cancel + rebook emails for an appointment she still had.
- **Bridget Voigt** — *Showed, roadmap booked* **sent** `PUT /opportunities/jdC9CKdIEVEjtKo19JQl` with
  `pipelineStageId = e1b9fbb8…` (Pre-Roadmap Booked) although the row's `before.stageId == after.stageId`. Lara Kujtan
  (Oct 29) and Jacob Wright (Oct 30 08:15) in the same situation were skipped "already in Pre-Roadmap Booked". A
  same-stage re-save can re-fire GHL's stage workflows (the roadmap-booked congratulations email).

Principle: a stage move Miranda chose is intended (its automations are wanted). Anything else FitFlow touches must not
re-trigger client messages. The write path keeps its allow-list and its three calls; nothing here adds a GHL write
(`verify-readonly.sh` unchanged). Order of work, one commit each: 0 plan → 1 reschedule never cancels → 2 never re-save
a stage (live re-read, backward rule) → 3 say what GHL will do → 4 audit script → 5 report + CLAUDE.md. Not pushed.

## Root cause of #2 (found in the live row, then in the code)

Live row `6a57d161` (2026-10-30 18:27:39 UTC = 12:27:39 MDT): `before = after = { Pre-Roadmap Booked, open }`, stage
step `ok`, request `PUT /opportunities/jdC9CKdIEVEjtKo19JQl { pipelineId, pipelineStageId: e1b9fbb8… }`, HTTP 200.

`lib/companion/log.ts#executeLog` (stage 2, as shipped):

1. line 270 `planLog(input, deps)` builds `plan.steps` from the **mirror** (`readContactPosition` →
   `ghl_opportunities`). The hourly sync had not seen the roadmap booking GHL made ~2 min earlier, so the mirror said
   Consult Booked and the stage step got a request to Pre-Roadmap Booked.
2. lines 274–283: the live re-read found Pre-Roadmap Booked ≠ `expectedStageId` (Consult Booked, from the plan's own
   mirror read) → 409 "Stage changed to Pre-Roadmap Booked since you opened this — continue?". Miranda pressed
   *Continue anyway* → `acceptedStageId = e1b9fbb8…` → the check passed.
3. **line 285** `if (liveStage !== plan.before.stageId) plan.before = { …live }` rewrote `before` (and `after` only when
   the outcome has no stage) — but **`plan.steps` was never recomputed**: lines 296–297 copied the stale stage request
   into the row and `runSteps` sent it. The decision was made from the brief cache, the record from the live read.

Lara / Jacob differed only in timing: a sync had landed between the booking and the log, so the mirror already said
Pre-Roadmap Booked and `planLog` skipped the step.

## 1. Reschedule never cancels

- (a) `RESCHEDULE_APPOINTMENT_DEFAULT = 'leave'`; `rescheduleAppointmentOf` reads only the literal `'cancelled'` as
  cancelled. Migration `0024_companion_reschedule_leave.sql`: no stored row (the old default was in force, never
  edited) → INSERT `'leave'`; a stored `'cancelled'` row is a human's choice → kept, `RAISE NOTICE` naming it; a
  stored `'leave'` → nothing. Setup → Companion: the option reads **"Cancel the appointment (GHL may email the
  client)"**; "leave" reads "Leave the appointment as is (default)". The footer line for Reschedule reads
  **"Moves to Consult Reschedule · appointment unchanged · adds note"**.
- (b) works: `GET /api/setup/companion` → `rescheduleAppointment: "leave"`; a Reschedule log's row has
  `steps.appointment = { status: 'skipped', reason: 'left as is' }`, `after.appointmentStatus` = the live status.
- (c) fails: an owner who stored `'cancelled'` keeps it and sees the warning label; the migration prints
  `NOTICE: companion_reschedule_appointment is 'cancelled' (set by the owner) — kept`.
- (d) `tests/companion-outcomes.test.ts` (default rows now `leave`; `rescheduleAppointmentOf`), a migration replay
  test on PGlite for the three cases, `tests/companion-popout.test.ts` (the line). Live: read-only
  `readRescheduleAppointment()` against the production database before/after (the production row is absent today —
  printed in the report).

## 2. Never re-save a stage

- (a) `lib/companion/decide.ts` (pure): `decideStage({ live, pipeline, resolved, stages, isMoveTo })` and
  `decideAppointment({ call, liveStatus, effect })`. Both `planLog` and `executeLog` read GHL LIVE first —
  `getOpportunity` (exists) and a new read-only `getAppointment(eventId)` (`GET /calendars/events/appointments/{id}`,
  family calendars; runtime evidence 2026-10-30: the body key is `appointment`, not the documented `event`, with
  `appointmentStatus`) — and build `before`, the stage decision, the appointment decision and the note text from
  THAT read. The mirror now contributes only the contact name, the opportunity id and the pipeline. Rules:
  - stage AND status already equal the target → skipped `already in <stage>`;
  - a mapped outcome whose target sits EARLIER in the pipeline order than the live stage → skipped
    `already past <target> (in <current>)`; only "Move to…" may go backward, and its line reads "Moves back to …";
  - the appointment's live status already equals the target → skipped `already <status>`;
  - the 409 stale-stage prompt stays (live stage ≠ expected ≠ accepted); after *Continue anyway* the steps are
    recomputed from the live read (the fix for Bridget).
- (b) works: Bridget's case → row `steps.stage = { skipped, reason: 'already in Pre-Roadmap Booked' }`, appointment
  PUT showed, note POST; `writes()` has no `/opportunities/` PUT.
- (c) fails: GHL unreadable → 502 "GoHighLevel could not be re-read before writing: … — nothing was changed" (plan
  and confirm), no row, red footer line; an event GHL no longer has → 502 naming it.
- (d) `tests/companion-log.test.ts`: Bridget's exact case (stale mirror + live = target, through the 409 → accepted
  path AND through a fresh plan), backward skip, appointment-equal skip, Move to backward sends with "Moves back",
  unreadable appointment → 502. Live: `npm run companion:audit` shows no same-stage PUT after deploy.

## 3. Say what GHL will do

- (a) The confirm-phase footer line is built from the PLAN's steps (`popoutState#planEffectLine`): skipped steps are
  omitted; "appointment unchanged" when the call's event is left alone; "Moves back to X" for a backward Move to.
  When an outcome would change an appointment status (showed / noshow / cancelled) a second small line reads
  **"GHL automations on appointment status may message the client."** — in the pop-out (pick + confirm phases) and
  on Setup's outcome map per outcome (effective appointment after the Reschedule rule).
- (b) works: Reschedule → "Moves to Consult Reschedule · appointment unchanged · adds note" (no automation line);
  roadmap booked, stage already there → "Marks showed · adds note" + the automation line.
- (c) fails: a plan error replaces the line in red (unchanged behaviour).
- (d) `tests/companion-popout.test.ts` (`planEffectLine`, `automationNote`), the screenshot run asserts no scroll at
  360×560 with the extra line; preview states `confirm_reschedule`, `confirm_roadmap_booked` (Bridget-type) in both
  themes.

## 5. Appointment status switch (added by Mitchell mid-build, 2026-10-30)

Evidence: Bridget Voigt, Oct 30 — the PUT `appointmentStatus=showed` at 12:27 MDT re-fired GHL's consult-confirmation
workflow at 12:28 ("(Watch This) Before Your Consult!" email + confirm SMS + video), because that workflow triggers on
ANY appointment status change.

- (a) Setup → Companion "Update appointment status in GoHighLevel": On / Off, **default OFF** until Mitchell turns it
  on (`settings.companion_appointment_updates`, only the literal `'true'` is on). Off → every outcome leaves the
  appointment untouched (step skipped `appointment updates are off in Setup`); the stage + note still go. Warning beside
  it: "Turn on only after GHL workflows that trigger on appointment status filter to Confirmed/Booked." The footer
  reads "appointment unchanged".
- (b) works: `GET /api/setup/companion` → `appointmentUpdates: false`; a row's `steps.appointment = { skipped,
  reason: 'appointment updates are off in Setup' }`.
- (c) fails: a malformed stored value reads OFF (fail safe); the PATCH refuses a non-boolean (400).
- (d) `tests/companion-log.test.ts`: Off → no appointment PUT for any outcome; On → the current behaviour;
  `tests/companion-stage5.test.ts` for the parser and the decision; `tests/companion-outcomes.test.ts` for the PATCH.

## 4. Audit script

- (a) `npm run companion:audit -- --days 7` (`scripts/companion-audit.ts`, read-only, database only): every action in
  the window with each step's request, flagging (a) a stage PUT whose `pipelineStageId` equals `before.stageId`,
  (b) an appointment set to cancelled, (c) a backward move (target position < live position, `stages`).
- (b) works: Bridget flagged SAME-STAGE PUT, Sindhu flagged APPOINTMENT CANCELLED; the output is in the report.
- (c) fails: no database → the usual connection error; exits 0 (an audit lists, it does not gate).
- (d) run on the production database (read-only) and pasted into `docs/companion-stage5-report.md`.
