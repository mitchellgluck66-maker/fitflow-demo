# Onboarding Companion — Stage 1 report (2026-10-16)

Plan: `docs/plan-companion-stage1.md`. Six commits on `main`, not pushed. Writes NOTHING to GoHighLevel:
`ENABLE_WRITEBACK` untouched, every new GHL call a GET through `ghlRequest`, `scripts/verify-readonly.sh` unchanged.

## Gates

| Gate | Result |
|---|---|
| `npm run check` (typecheck · vitest · verify:readonly · build) | green — 99 files, 975 tests, read-only guard ✓, build ✓ |
| `scripts/verify-readonly.sh` | unchanged, passing |
| `npm run companion:check -- --ghl-user gUYW4bOBKjgrgFCBAW6W` (live, production tenant, read-only) | **PASS 5/5** days (Oct 12–16) |
| Screenshots | `docs/screens/{light,dark}/companion-{day,day-mobile,popout,settings,settings-mobile}.png` (demo tenant) |

## What works (verified)

- **Logins + roles.** `app_users` (migration 0021, RLS on), scrypt hashes, v2 session tokens carrying uid + role, v1
  cookies still accepted as the env owner, the team password still signs an owner in. The interceptor sends an
  onboarding login to `/companion` from any other page and answers 403 on any other API — proved on every route group
  in `tests/companion-auth.test.ts` (14 pages, 20 API families). Disabling a user takes effect on their next Companion
  / Users call (401 "Account disabled or removed"). Setup → Users: add / disable / enable / reset password / link the
  GHL user; the password is shown once and never echoed by the API.
- **My day.** Live GHL reads per calendar, matched by assigned user (`assignedUserId` or `users[]`), cached 120 s,
  mirror fallback with "Showing data from <time> — GoHighLevel could not be reached: <reason>" and Retry. Status chips,
  counter, date stepping, owner "viewing as". `tests/companion-day.test.ts` (14).
- **Pop-out.** Document Picture-in-Picture (Chrome 116+) holding `/companion/popout`; plain popup elsewhere with the
  "can't float" line. Auto-selection (±10 min → in progress → next → last), ◀ ▶ pin, search (mirror + live GHL),
  the brief (name, email, phone, call type, days in pipeline with its basis, stage + pipeline, last 3 notes or
  "Notes unavailable: <reason>"), disabled outcome area "Logging arrives in stage 2". `tests/companion-brief.test.ts` (9).
- **Settings.** Calendar filter (live list, mirror fallback with the reason), time zone, auto-advance, change
  password; the team-password owner gets 409 "Sign in with a personal login". `tests/companion-settings.test.ts` (4).

## Findings from the live check (the reason the check exists)

1. **GHL's `/calendars/events` applies the window at day granularity in the calendar's timezone.** The first live run
   FAILED 4 of 5 days: a one-day request (Oct 13, 00:00–23:59 Edmonton) returned Oct 12's calls from 06:00 Pacific, so
   the Companion showed 10 calls on a day with 3. Probe evidence: the five single-day reads summed to 30 events while
   the five-day window held 17. Fixed by construction — the loader keeps only events whose start lies inside our own
   instants (`lib/companion/source#withinWindow`, regression test) — and recorded under CLAUDE.md rule 7. The hourly
   sync is unaffected (its wide window is a superset; rows keep their true start times).
2. **Miranda's calls span nine calendars**, not the five in the brief ("10 Minutes with Miranda", "Internal: 15-Minute
   Fit Physician Consult", "Roadmap Session" `8cAx82WDP1NM68LGAr7g`, and `xi12dMv3q8fsSmNniOmH` renamed from "Back to
   School …" to "Midlife Muscle Method Scholarship Roadmap Session"). Matching by assigned user covers them all.
3. **The mirror keeps one Oct 12 appointment GHL no longer lists** (mirror 8, live 7). The sync never deletes a calendar
   event; a cancelled-and-removed booking stays until something marks it. Not a Companion bug — worth a sweep in the
   sync later (compare the mirror's day against the live day and mark vanished events).
4. Only 2 of Miranda's 773 synced appointments are `showed` in GHL (692 `confirmed`): outcomes are rarely recorded, so
   "Needs outcome" will dominate past calls until stage 2 logs them.

## What fails / is not done

- Nothing in the brief is missing. Stage 2 items (logging, "Logged" chips) are placeholders by design.
- The demo tenant has no GHL credentials, so the demo screenshots show the honest mirror banner and
  "Notes unavailable" — the live states (green "Live from GoHighLevel, 10:42 AM", real notes) were exercised by
  `companion:check` and the API, not photographed.

## What Mitchell must verify by hand

1. **Deploy order:** `npm run db:migrate` (0021 is additive) THEN push. Then Setup → Users → Add user: Miranda,
   onboarding, GHL user "Miranda Murphey" (`gUYW4bOBKjgrgFCBAW6W`), copy the one-time password.
2. **Log in as Miranda** in a private window: lands on `/companion`; typing `/scorecard` bounces back; the day matches
   her GHL calendar; "Needs outcome" on past calls; Settings saves; the password change works.
3. **The pop-out over Zoom in full-screen on her Mac** (Chrome 116+): click Pop out, join a Zoom call in full-screen,
   confirm the 360×520 window stays on top and the brief auto-advances at the next call. Safari / Firefox show the
   "can't float" line instead. Nothing here could be exercised from this machine.
4. **Notes access:** on production `GET /contacts/{id}/notes` was reachable with the stored token (the check's calls
   succeeded); if the brief ever shows "Notes unavailable: GHL 401/403", add `contacts.readonly` (notes) to the Private
   Integration's scopes and rotate the token.
5. `npm run companion:check -- --user <miranda's email>` once her login exists (so her calendar filter is the one
   checked).
