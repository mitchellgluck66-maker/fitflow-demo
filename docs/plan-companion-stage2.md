# Onboarding Companion — Stage 2 (write outcomes to GoHighLevel) — plan

Date: 2026-10-18. Owner: Mitchell. Builder: Claude Code. Follows CLAUDE.md and the Definition of done.

Stage 2 is the FIRST sanctioned write path to GoHighLevel. It changes rule 1 in exactly one way: the Companion's
outcome log may write, through ONE module (`lib/companion/ghlWrite.ts`), with its OWN key, to an allow-list of
exactly three calls. Everything else stays as it was: `ENABLE_WRITEBACK` is the literal `false`, `ghlRequest` still
throws on any non-GET, the dashboard and every sync use the read-only key only, and `scripts/verify-readonly.sh`
now proves both halves (no non-GET outside the write module; the write module reaches only the three paths).

Facts the build rests on (stage 1 code + the GHL API docs):

- The followed pipeline's stages carry semantic roles (`stages.semantic_role`, Setup → Pipelines). Every outcome
  names a ROLE; the stage is resolved from the role at log time. No stage name is hard-coded anywhere.
- GHL writes: `PUT /opportunities/{id}` takes `pipelineStageId` and `status` (Version 2021-07-28);
  `PUT /calendars/events/appointments/{eventId}` takes `appointmentStatus` (the calendar family header);
  `POST /contacts/{contactId}/notes` takes `{ body, userId }`. GHL has no transactions across these three calls —
  hence per-step results, retry of the missing steps only, and undo.
- An onboarding login may reach only `/companion*` and `/api/companion/*`. Owner-only administration of the
  Companion (key, dry run, outcome map) therefore lives under `/api/setup/companion/*`, which the policy already
  denies to onboarding; the pop-out reads what it needs from `/api/companion/*`.
- The private integration token for writes needs `opportunities.write`, `calendars/events.write` and
  `contacts.write` (plus the read scopes the probe uses). GHL offers no scope introspection: the Verify button can
  prove the token authenticates to the location; only the live test proves the write scopes.

## Item 1 — separate write key + guard

**(a) What it does.** A second GHL credential, `ghl_companion_write_token` (settings row, `is_secret`, sealed with
`CREDENTIALS_KEY` like every secret), entered on Setup → Companion ("Companion write key", masked, Verify).
`lib/companion/ghlWrite.ts` is the ONLY module that can send a non-GET to GoHighLevel:

- Its own `fetch` transport (injectable for tests), its own token (never `ghl_api_token`, never the env fallback),
  the same `GHL_BASE_URL` constant, the same Version headers per family, the same 429-once retry.
- `WRITE_ALLOW_LIST` = exactly three entries: `PUT ^/opportunities/{id}$`, `PUT ^/calendars/events/appointments/{eventId}$`,
  `POST ^/contacts/{contactId}/notes$`. `assertAllowed(method, path)` runs BEFORE any I/O and throws
  `CompanionWriteRefused` for anything else (another path, a query string, a GET, a DELETE, a path with `..`).
  Bodies are built by the three typed functions only — `updateOpportunity(id, { pipelineStageId?, status? })`,
  `updateAppointmentStatus(eventId, status)`, `addContactNote(contactId, body, userId?)` — and validated with Zod
  (`status` ∈ open | won | lost; `appointmentStatus` ∈ GHL's enum).
- `verifyWriteToken()` = one `GET /opportunities/pipelines?locationId=` with the WRITE token through the module's
  transport (a read probe, listed separately from the allow-list; the only GET the module can make). It proves the
  token authenticates to the configured location. The card says so and names the live test for the write scopes.
- `scripts/verify-readonly.sh` gains: (6) `GHL_BASE_URL` is imported only by `lib/ghl/client.ts` and
  `lib/companion/ghlWrite.ts`; (7) no non-GET method literal exists in any file that touches GHL outside
  `lib/companion/ghlWrite.ts` and the two dormant modules; (8) every path pattern in `ghlWrite.ts` is one of the
  three, and the module's `fetch` is reachable only after `assertAllowed`.

**(b) When it works.** Setup → Companion: "Write key ••••••ab12 · verified against location <id> · write scopes are
proven by `npm run companion:live-test`". `GET /api/setup/companion` →
`{ writeKey: { configured: true, preview: '••••••ab12', verifiedAt, verification: { ok: true, message } } }`. DB:
`settings.ghl_companion_write_token` = `enc:v1:…`. `npm run verify:readonly` prints steps 1–8 with ✓.

**(c) When it fails.** A wrong key → "Verification failed: GHL 401 GET /opportunities/pipelines: …", badge "Saved —
verification failed". Any code calling `companionWrite` with another path → `CompanionWriteRefused: Refused DELETE
/contacts/x: not in the Companion write allow-list` thrown before `fetch`. No write key saved → every log attempt is
refused with "No Companion write key — the owner adds it in Setup → Companion" (HTTP 412), nothing sent, no row.
`verify-readonly.sh` exits 1 naming the offending file:line.

**(d) Verified by.** `tests/companion-write.test.ts`: the allow-list (each of the three passes; 12 near-misses throw
before I/O — the fetch spy is never called); the write token is read from its own setting and the read token is
never sent; headers per family; the 429 retry; the error text never contains the token; `verifyWriteToken` happy /
401. `npm run verify:readonly`. Live: Mitchell pastes the key, presses Verify.

## Item 2 — dry run, default ON

**(a)** `settings.companion_dry_run` = `'true'` by default (DEFAULTS; a missing row is ON). While on: the whole log
flow runs — plan, GHL re-read, request id, per-step results, undo — but `ghlWrite` is called with `dryRun: true`
and returns `{ status: 'dry_run' }` without touching the transport; the row is stored with `dry_run = true`,
`state = 'dry_run'`, each step `{ status: 'dry_run', request: { method, path, body } }`; our mirror rows are NOT
updated (nothing changed in GHL). The pop-out shows a yellow banner "Dry run — outcomes are logged, nothing is sent to
GoHighLevel"; Setup → Companion shows the same banner with the toggle. Turning it off asks the owner to confirm
("Outcomes logged from now on will move stages, set appointment statuses and add notes in GoHighLevel") and the
PATCH carries `confirm: true`; the API refuses without it.

**(b)** Pop-out banner visible; a logged call's chip reads "Dry run · Showed, roadmap booked"; row
`companion_actions.state = 'dry_run'`; `GET /api/companion/outcomes` → `{ dryRun: true, … }`.

**(c)** `PATCH /api/setup/companion { dryRun: false }` without `confirm: true` → 400 "Confirm turning dry run off".
A malformed stored value (anything but `true`/`false`) reads as ON (fail safe) and Setup shows "dry run: on (value
'x' is not valid)".

**(d)** `tests/companion-log.test.ts` "dry run sends nothing": the transport spy is never called, the row exists
with state `dry_run`, the mirror is unchanged. `tests/companion-outcomes.test.ts` "dryRunOf" — the fail-safe parse.

## Item 3 — outcome map (owner-editable, role-based)

**(a)** `lib/companion/outcomes.ts` (pure): the catalogue of outcomes per call type, each `{ key, label, stageRole |
null (unchanged), appointment: 'showed' | 'noshow' | 'cancelled' | 'leave' | 'reschedule_setting',
opportunityStatus: 'open' | 'won' | 'lost' | null (unchanged) }`. Defaults:

| Call | Outcome | Stage (role) | Appointment | Opportunity |
|---|---|---|---|---|
| Consult | Showed, roadmap booked | roadmap_booked | showed | open |
| Consult | No-show | consult_noshow | noshow | open |
| Consult | Reschedule | consult_rescheduled | setting (default cancelled) | open |
| Consult | Cancelled | unchanged | cancelled | open |
| Consult | Not a fit | unchanged | showed | lost |
| Roadmap | Enrolled | enrolled | showed | won |
| Roadmap | Showed, objection | roadmap_showed | showed | open |
| Roadmap | No-show | roadmap_noshow | noshow | open |
| Roadmap | Reschedule | roadmap_rescheduled | setting | open |
| Roadmap | Not a fit | unchanged | showed | lost |

Plus "Move to…" for any call type (and for a person opened from search with no call): any stage of the followed
pipeline (by stage id, shown by name) + appointment status showed / noshow / cancelled / leave; the opportunity
status is unchanged. `settings.companion_reschedule_appointment` = `cancelled` | `leave` (default cancelled).
`settings.companion_outcome_map` = JSON overrides per outcome key `{ stageRole, appointment, opportunityStatus }`,
validated against the role list and the enums; an invalid override is ignored with a Setup warning naming it.
`resolveStage(role, stagesOfFollowedPipeline)` → the stage mapped to that role (lowest position when several);
none → the outcome is refused with "No stage in <pipeline> is mapped to the role <role> — map it in Setup →
Pipelines" (never a guess, never a name match). Setup → Companion shows the table with a select per cell and
Reset to defaults.

**(b)** `GET /api/companion/outcomes?contact=&event=` → `{ dryRun, callType, outcomes: [{ key, label, toStage:
{ id, name } | null, appointment, opportunityStatus }], moveTo: { stages: [{ id, name, role }], appointments } }`.
The pop-out lists the outcomes of the call's type as buttons.

**(c)** A role with no stage → that outcome's button is disabled with the reason as its title and the plan API
answers 422 with the same sentence. No followed pipeline → every stage-changing outcome disabled, "Follow a
pipeline in Setup first".

**(d)** `tests/companion-outcomes.test.ts`: every default row above (both call types), the reschedule setting both
ways, Move to, overrides applied / rejected, stage resolution by role incl. the missing-role refusal and the
lowest-position tie.

## Item 4 — logging flow

**(a)** Pop-out: outcome buttons → note (required, ≥ 10 characters; the Log button stays disabled and the count
shows "4 / 10") → Log → confirmation sheet: "Move <client> from <stage> to <stage>, mark the <time> <type>
<status>, add this note. This may send GoHighLevel messages to the client." (with "Dry run — nothing will be sent"
when on) → Confirm.

- `POST /api/companion/actions/plan` `{ contact, event?, outcome | move, note }` → the resolved plan `{ opportunity:
  { id, pipeline, from: { id, name }, to: { id, name } | null, status: { from, to } }, appointment: { eventId, from,
  to } | null, noteText, expectedStageId, dryRun }` or 422 with the reason (note too short, role unmapped, contact
  not in the followed pipeline → "stage step unavailable: no opportunity in <pipeline>" — the sheet says the stage
  step will be skipped).
- `POST /api/companion/actions` `{ requestId, contact, event?, outcome | move, note, expectedStageId,
  acceptedStageId? }`:
  1. The server re-reads the opportunity from GHL (`getOpportunity`, read-only client). Stage ≠ `expectedStageId`
     and ≠ `acceptedStageId` → 409 `{ staleStage: { stageId, stageName } }`; the pop-out shows "Stage changed to
     <X> since you opened this — continue?" and resends with `acceptedStageId`. The GHL read failing → 502 with the
     reason (nothing written, no row).
  2. `request_id` is UNIQUE: an insert conflict returns the existing row (a double-click or a resent request never
     applies twice); the client mints one UUID per Log press.
  3. Steps in order — stage (`PUT /opportunities/{id}` with `pipelineStageId` + `status`) → appointment
     (`PUT …/appointments/{eventId}`) → note (`POST /contacts/{id}/notes`, body "Onboarding call · <type> ·
     <date time> · <user>\nOutcome: <label> (<from> → <to>)\nNote: <text>", `userId` = the login's GHL user). Each
     step's result `{ status: ok | failed | skipped | dry_run, httpStatus, body (≤ 2 KB), error, at }` is written
     to the row as it completes. A failed step stops the sequence (later steps stay `pending`).
  4. State: `ok` (every step ok or skipped) · `partial` (some ok, one failed) · `failed` (the first step failed) ·
     `dry_run` · `undone`. A partial / failed row opens ONE `companion_action_failed` warning incident naming the
     client, the step and the error (resolved by a successful retry or an undo).
  5. On success the mirror follows at once: `contacts.stage_id / opportunity_status / last_stage_change_at`,
     `ghl_opportunities.stage_id / status`, `appointments.ghl_status / outcome`, and one `stage_transitions` row
     (`kind = 'companion'`, `observed_at = now`, ON CONFLICT DO NOTHING) so the funnel and the daily to-do see the
     move before the next hourly sync (which will observe the same state and write nothing).
- Retry: `POST /api/companion/actions/{id}/retry` re-runs only the steps not `ok` / `skipped`, in order, on the
  same row; the pop-out shows three per-step checks and "Retry" on the failing one.
- Undo (5 minutes from `created_at`, `UNDO_WINDOW_MS`): `POST …/{id}/undo` reverses only the steps that were
  applied, in reverse order — appointment status back to `before.appointmentStatus`, opportunity back to
  `before.stageId` + `before.status`, then the note "Undone by <user>" — records `undo_steps`, sets `state =
  'undone'`, `undone_at / undone_by`, reverts the mirror rows (reverse transition). Past the window → 410 "Undo
  closed at <time>". A dry-run row undoes without sending.
- My day: `CompanionCall.action` `{ id, state, label, createdAt, undoUntil }`; chips Logged · <label> (green),
  Failed · <step> (red, Retry), Dry run · <label> (yellow); the counter's "logged" counts ok + dry_run. A partial
  or failed log stays red until retried or undone and is listed on Setup → Companion ("1 failed log") and in
  Incidents.

**(b)** Pop-out after Confirm: three rows "Stage ✓ Consult Booked → Pre-Roadmap Booked", "Appointment ✓ showed",
"Note ✓ added" with "Undo (4:58)"; My day chip "Logged · Showed, roadmap booked". GHL: the opportunity in the new
stage, the event `showed`, the note on the contact. DB: one `companion_actions` row, `state = 'ok'`, `steps.*.status
= 'ok'` with the HTTP 200s, a `stage_transitions` row with `kind = 'companion'`, the contact's `stage_id` updated.

**(c)** Appointment step 4xx → sheet rows "Stage ✓ · Appointment ✗ GHL 422 PUT …: <body> · Note — not attempted",
"Retry" button; row `state = 'partial'`; incident `companion_action_failed` open; chip "Failed · appointment" (red)
on My day. Note < 10 chars → Log disabled, no request. Stage changed in GHL → the continue prompt, nothing applied
until accepted. No write key → 412 and the sheet says so. Undo after 5 min → 410.

**(d)** `tests/companion-log.test.ts` (PGlite + a scripted transport): happy path records three ok steps, the
mirror and the transition; the same request id twice → one row, one set of writes; a stale stage → 409 then
accepted → applied; appointment failure → partial, incident open, retry re-runs ONLY the appointment and the note,
incident resolved; undo inside the window reverses the applied steps only (reverse order, the "Undone by" note),
mirror reverted; undo after the window → refused; dry run → row + no transport call + mirror unchanged; the note
text format; a person with no appointment → appointment step `skipped`. Live: the pop-out on the demo tenant
(screenshots), then `npm run companion:live-test` (item 6) run by Mitchell.

## Item 5 — data

Migration `0022_companion_actions.sql` (additive, RLS on): `companion_actions (id, request_id UNIQUE, user_id,
user_name, ghl_user_id, ghl_event_id, ghl_contact_id, contact_id, ghl_opportunity_id, pipeline_id, call_type,
call_start_at, outcome_key, label, note, before jsonb, after jsonb, dry_run boolean, steps jsonb, undo_steps jsonb,
state text, error text, created_at, updated_at, undone_at, undone_by)`. Indexes on `ghl_event_id`, `ghl_contact_id`,
`created_at`. Append-only: no code path deletes a row (`tests/companion-log` asserts the module exports no delete;
`grep -rn "delete(companionActions)"` is empty). `before` / `after` = `{ stageId, stageName, status,
appointmentStatus }`.

## Item 6 — tests + proof

- Unit / integration: `tests/companion-write.test.ts`, `tests/companion-outcomes.test.ts`,
  `tests/companion-log.test.ts` (above), plus `tests/companion-day.test.ts` extended for the chips and
  `tests/readonly.test.ts` unchanged (the read client still throws).
- `scripts/companion-live-test.ts` (`npm run companion:live-test -- --contact <id> [--event <id>]
  --i-understand-this-writes`): refuses without the flag, with dry run ON, without a write key, or when the contact
  is not in the followed pipeline. Then, as the first active onboarding login: for every outcome of the Consult
  list then the Roadmap list and one Move to — log → re-read GHL (opportunity stage + status by id, the event's
  status, the newest contact note) → PASS/FAIL per check → undo → re-read → PASS/FAIL; a forced failure (the
  appointment step's transport answers 500 once) → state partial → retry → ok → undo. Finishes by undoing the last
  action so the contact ends where it started, and prints a summary + exit code. Every write goes through
  `ghlWrite`; the re-reads through the read-only client. **Not run by Claude.**
- Screenshots: `npm run screenshots -- --companion` captures `companion-popout-{confirm,success,partial,dryrun}`
  through the real pop-out from canned states (`GET /api/companion/preview?state=`, served only with
  `COMPANION_PREVIEW=1` outside production) and the Setup → Companion card.
- `npm run check` green; `npm run verify:readonly` extended and green.

## Not in this stage

Any other GHL write (tags, contact fields, calendar bookings), the dashboard's dormant attendance UI, Zoom/pop-out
verification, the Analyst's awareness of Companion actions.
