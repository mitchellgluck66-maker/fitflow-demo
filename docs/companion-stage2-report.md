# Onboarding Companion — Stage 2 report (2026-10-18)

Built from `docs/plan-companion-stage2.md`, one commit per item, not pushed. The dashboard stays provably read-only;
the Companion's outcome log is the ONE path that writes to GoHighLevel, under its own key and an allow-list of exactly
three calls. Nothing has touched GoHighLevel from this build: every write path was proven against a fake transport, and
the live test is Mitchell's.

## Works (verified by automated test on this machine)

| Item | What a person can do | Proof |
|---|---|---|
| 1 · write key + guard | Paste a second GHL key on Setup → Companion (masked, Verify); `lib/companion/ghlWrite.ts` is the only module that can send a non-GET to GHL — three paths, anything else throws before I/O; the read key is never sent for a write, the write key never used by a sync | `tests/companion-write.test.ts` 29 (allow-list, 15 near-misses before I/O, own key, headers, 429 retry, token never in an error, dry run sends nothing, Verify); `npm run verify:readonly` steps 6–8, proven to fail on a fourth path and on a stray non-GET |
| 2 · dry run | Default ON; the whole flow runs and records the exact requests, nothing is sent, the mirror is untouched; yellow banner in the pop-out and on Setup; turning it off needs a confirm | `tests/companion-log.test.ts` "dry run"; `tests/companion-outcomes.test.ts` (confirm required, malformed value reads ON) |
| 3 · outcome map | Owner-editable table by stage ROLE (Consult / Roadmap defaults from the brief, the reschedule rule, Move to… any stage); a role with no stage is refused in a sentence pointing at Setup → Pipelines | `tests/companion-outcomes.test.ts` 18 (every default row, both reschedule settings, Move to, overrides, lowest-position tie, Setup PATCH) |
| 4 · logging flow | Note ≥ 10 chars → confirmation sheet → GHL re-read with "Stage changed to X — continue?" → stage → appointment → note, each result stored as it lands; unique request id; Retry re-runs only the missing steps; Undo for 5 minutes with an "Undone by" note; our contact / appointment / opportunity rows and one `stage_transitions` row follow at once; one incident per failed log; My day chips Logged / Dry run / Failed | `tests/companion-log.test.ts` 13 (happy path with the exact wire order and bodies, idempotent request id, 409 then accepted, 502 on an unreadable GHL, partial + incident + retry of the missing steps only, undo inside / outside the window incl. a partial's undo, Move to without an appointment, refusals, append-only) |
| 5 · data | `companion_actions` (migration 0022, RLS on, append-only) | `tests/rls.test.ts`; the append-only grep in the log test |
| 6 · proof | Screenshots of the confirm sheet, success, partial failure and dry run through the real pop-out from canned states; the Setup card | `docs/screens/{light,dark}/companion-popout-{confirm,success,partial,dryrun}.png`, `companion-setup.png` |

Also in this build: the stage 1 Companion suites (auth, day, brief, settings) still pass with the new chips and counter.

## The check failure, fixed as a class (`tests/verify-harness.test.ts`)

`npm run check` was red on one test: n07 (Paid CAC, last week) crashed with `Cannot read properties of null
(reading 'paid')` because last week's independent SQL had no enrollment, so its `enrolled_by_att` aggregate was null.
The same run showed 26 engine-vs-SQL differences on the demo tenant. Root causes, all fixed:

- **Null aggregates.** `json_object_agg` / `json_agg` over no rows is null — `period`, `cohort`, `enrolled_by_att`,
  `show_rates`, a currency's money block. Every eval question now reads through null-safe accessors (a null is "not
  available", never a crash); `SqlOut` is typed nullable so the compiler keeps it so. `tests/eval-questions-null.test.ts`
  runs every question on an all-null JSON and on a sparse week.
- **The 26 differences were three stale rules in the SQL / harness, not the engine**, and not week boundaries:
  `has_stripe` read `origin = 'stripe'` (the engine's "awaiting Stripe" is NO payment rows at all → 8 ROAS lines);
  LTV:CAC was withheld while ANY contract value was missing (the engine applies the partial-data rule → 4 lines); a
  demo applicant was dated by the contact's creation instead of the application (a manual late entry sits 30 days
  earlier, on the wrong side of the Jul 16 boundary → 14 lines). One rule for every origin now; the harness test asserts
  **0 FAIL** on the demo tenant instead of reporting the count.
- **Week boundaries, checked anyway.** `runVerify` takes `now`; two tests pin it to Monday 02:30 UTC and Monday
  00:10 UTC — both still Sunday in Edmonton — and prove today is the business zone's Sunday, last week Oct 11–17, every
  question a number or null, 0 FAIL. Found on the way: the demo seed anchored its "today" and day boundaries to
  America/New_York; it now reads the business timezone from settings, so the seed, the engine and the SQL bucket days
  the same way.

## Fails / not verified

- **Nothing live.** No GoHighLevel write has been made. Unproven until the live test: that GHL accepts `pipelineId`
  + `pipelineStageId` + `status` in one `PUT /opportunities/{id}`; the calendar-family Version header on
  `PUT /calendars/events/appointments/{eventId}`; whether GHL lets a past event's status change (the live test's forced
  failure case exercises the retry path either way).
- **Verify proves the key, not the scopes.** The Setup Verify button makes one GET with the write key and proves it
  authenticates to the location; GHL has no scope introspection, so `opportunities.write`, `calendars/events.write`
  and `contacts.write` are proven only by the live test.
- **The pop-out's log panel was exercised through canned states and unit-level routes**, not driven end to end in a
  browser against a fake GHL (the Companion has no Playwright suite yet; stage 1 did the same).
- **Undo cannot delete the note** (not in the allow-list by design): it adds "Undone by <user>" instead.

## What Mitchell must verify by hand

1. **Deploy order:** `npm run db:migrate` FIRST (0021 `app_users` from stage 1 if not yet applied, 0022
   `companion_actions`; both additive and safe for the deployed code), THEN `git push`. `CREDENTIALS_KEY` must be set
   in Vercel already (H4) — the write key is sealed with it.
2. **Setup → Users** (stage 1): Miranda's login linked to her GHL user, if not done.
3. **Setup → Companion:** paste the Companion write key (a second Private Integration Token with
   `opportunities.write`, `calendars/events.write`, `contacts.write` plus the read scopes), press **Verify** — expect
   "Write key accepted for location <id> (N pipelines readable)". Leave **dry run ON**.
4. **Dry-run walk:** as Miranda, open the pop-out on a real call, pick an outcome, write a note, Confirm — the three
   steps read "dry run — not sent", My day shows "Dry run · <outcome>", Setup → Companion lists nothing failed.
   Check GoHighLevel changed nothing.
5. **The live test**, once Jake names a test contact (in the followed pipeline, with a test appointment assigned to
   Miranda) and the key is on Setup:
   ```
   # Setup → Companion → turn dry run OFF (confirm), then:
   npm run companion:live-test -- --contact <ghl contact id> --event <ghl event id> --i-understand-this-writes
   # expect: PASS per check, "contact ends where it started", N GHL writes sent; then turn dry run back ON
   ```
   It refuses without the flag, with dry run ON, without a write key, or when the contact has no followed-pipeline
   opportunity in the mirror (run a sync first). Every log is undone, so the contact ends where it started; read the
   GHL notes afterwards — each outcome leaves its note and its "Undone by" note.
6. **Then** turn dry run OFF for Miranda for real, and watch Setup → Companion's "failed logs" and Incidents for
   `companion_action_failed` the first week.

## Numbers

- `npm run check`: see the last line of this report's commit message (typecheck · Vitest · verify:readonly · build).
- Vitest on this machine before the gate: Companion suites 81; `tests/eval-questions-null` 2; `tests/verify-harness`
  5 (the demo tenant 0 FAIL; two pinned instants).
