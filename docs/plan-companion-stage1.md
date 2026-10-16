# Onboarding Companion — Stage 1 (read-only) — plan

Date: 2026-10-16. Owner: Mitchell. Builder: Claude Code. Follows CLAUDE.md and the Definition of done.

Stage 1 writes NOTHING to GoHighLevel: `lib/ghl/config.ts#ENABLE_WRITEBACK` stays the literal `false`, every new GHL
call is a GET through `ghlRequest`, and `scripts/verify-readonly.sh` is not touched. The Companion is a second,
narrower front door onto the same mirror and the same read-only GHL client.

Facts found in the data (production mirror, read-only query 2026-10-16):

- Miranda Murphey's GHL user id is `gUYW4bOBKjgrgFCBAW6W` (773 synced appointments are assigned to it).
- Her appointments span NINE calendars, not the five in the brief — the four extra are "10 Minutes with Miranda",
  "Internal: 15-Minute Fit Physician Consult", "Roadmap Session" (`8cAx82WDP1NM68LGAr7g`) and a renamed
  `xi12dMv3q8fsSmNniOmH` (both "Back to School …" and "Midlife Muscle Method Scholarship Roadmap Session"). This is
  why matching is by ASSIGNED USER, with the calendar list only a per-user filter.
- Only 2 of her 773 appointments are `showed` in GHL and 692 are still `confirmed`: outcomes are mostly not recorded
  in GHL, so "Needs outcome" will be the common state for past calls until stage 2 logs them.
- `settings.ghl_followed_calendars` is unset (the sync reads every active calendar); business timezone
  America/Edmonton. 171 of her last 177 appointments are linked to a mirrored contact — the other 6 need a live
  contact read for the name.

## Item 1 — logins + roles

**(a) What it does.** Per-person logins in a new `app_users` table; roles `owner` | `onboarding`; the request
interceptor enforces the role; the shared `APP_PASSWORD` keeps working as the owner login; an owner-only Users card
on Setup (the app's settings page) adds / disables users and resets passwords.

- Migration `0021_companion_users.sql`: `app_users (id, name, email, role, password_hash, ghl_user_id, active,
  preferences jsonb, created_at, last_login_at)`, unique index on `lower(email)`, ROW LEVEL SECURITY on (C2).
  `preferences` is one column beyond the brief's list: it holds item 4's per-user calendar filter, timezone and
  auto-advance.
- `lib/auth/password.ts`: scrypt (node:crypto, N=16384 r=8 p=1, 16-byte salt) → `scrypt$<params>$<salt>$<hash>`;
  `verifyPassword` is constant-time; minimum 10 characters. No argon2 dependency needed.
- Session token v2 `v2.<iat>.<exp>.<uid>.<role>.<sig>` (`lib/auth/session.ts`). A v1 token already in a browser is
  still accepted as the env owner until it expires — nobody is logged out by the deploy. Role and user id are not
  secrets; the token still carries no password and no data.
- `lib/auth/policy.ts#decide` now returns the claims and applies `roleAllows(role, pathname)`: `owner` → everything;
  `onboarding` → `/companion`, `/companion/*`, `/api/companion/*`, `/api/auth/*` and the exempt paths only. Any other
  page → 307 `/companion`; any other API → 403 JSON `{ error: 'Forbidden', detail: 'This login can only use the
  Companion.' }`. The sliding refresh re-signs the SAME claims.
- `POST /api/auth/login { email?, password }`: an active `app_users` row for the email → scrypt check → v2 session
  (`last_login_at` updated); a disabled row → 401 "This account is disabled"; otherwise, the team password
  (`APP_PASSWORD`) → owner session with uid `env-owner`; otherwise 401 "Wrong email or password". Rate limit unchanged
  (5/min/IP). The password is never logged, never echoed.
- `/login` gains an Email field (optional: "Owners can leave it blank and use the team password"). An onboarding
  login lands on `/companion` whatever `next` said.
- `lib/auth/currentUser.ts`: the one server-side reader of the cookie → `{ uid, role, name, email, ghlUserId,
  preferences, source: 'db' | 'env' | 'dev' }`; a disabled or deleted user resolves to null and the API answers 401
  with "Account disabled or removed" (the proxy accepted the token; the data layer re-checks `active` on every
  Companion / Users call, so disabling takes effect on the next request). Local dev with auth off → a dev owner.
- `GET/POST /api/users`, `PATCH /api/users/[id]` (owner only, re-checked in the route): list; add (name, email, role,
  GHL user from the live `listUsers()` list or none, password typed or generated client-side); disable / enable;
  reset password; set GHL user. Responses never include a hash or a password.
- Setup → `UsersCard`: table (name, email, role, GHL user, active, last login) + Add user form + per-row Disable /
  Enable / Reset password / Edit GHL user. Default open while no onboarding user exists.

**(b) When it works.** Login page: Email + Password; Miranda signs in → `/companion` opens; typing `/scorecard` in the
address bar → back on `/companion`; `curl -b cookie /api/scorecard` → `403 {"error":"Forbidden","detail":"This
login can only use the Companion."}`. Mitchell signs in with the team password and no email → the Command Center as
before. DB: one `app_users` row per person, `password_hash` starting `scrypt$`, `last_login_at` set on sign-in.
`/setup` → Users: "2 users · 1 onboarding".

**(c) When it fails.** Wrong password → 401 "Wrong email or password" (same text for an unknown email). Disabled →
"This account is disabled". A Companion API call by a disabled user → 401 "Account disabled or removed" and the page
sends them to `/login`. Production without `APP_PASSWORD` / `AUTH_SECRET` still fails CLOSED (503) — unchanged.

**(d) Verified by.** `tests/companion-auth.test.ts`: hashing round trip + constant-time + min length; v2 sign /
verify / v1 compatibility; `roleAllows` on EVERY route group (`/`, `/scorecard`, `/funnel`, `/ads`, `/revenue`,
`/clients`, `/reports`, `/setup`, `/metrics`, `/settings`, `/today`, `/api/scorecard`, `/api/settings`, `/api/users`,
`/api/analyst/*`, `/api/sync`, `/api/clients` → denied for onboarding; `/companion*`, `/api/companion/*`,
`/api/auth/logout` → allowed; everything → allowed for owner); the interceptor end to end (307 / 403 / allow /
refresh keeps claims); the login route against PGlite (db user, disabled user, env owner, wrong password); the Users
API owner-only (403 for onboarding even with a valid cookie). Live: Mitchell adds Miranda in Setup → Users, signs in
as her in a private window, confirms the redirect and the 403.

## Item 2 — My day (`/companion`)

**(a)** Her calls for a chosen date (default today in her timezone), read LIVE from GHL with a 2-minute cache, falling
back to the mirror with a visible banner.

- `lib/companion/calendars.ts` (pure): `callTypeOf(calendarName, title)` → Consult | Roadmap | Other;
  `isAssignedTo(event, ghlUserId)` = `assignedUserId === id` OR `users[]` contains id.
- `lib/companion/day.ts` (pure): `statusOf(call, now)` → `up_next` (starts later) | `in_progress` (now between start
  and end, end defaulting to start + 30 min) | `needs_outcome` (ended, no outcome in GHL) | `logged` (reserved — stays
  empty in stage 1; a call whose outcome GHL already holds shows a secondary "GHL: showed / no-show / cancelled" tag);
  `summarize(calls)` → `{ calls, logged, needOutcome }`; `selectCurrent(calls, now)` → the call starting within
  ±10 min of now, else the next upcoming, else the last of the day.
- `lib/companion/source.ts`: `loadMyDay({ ghlUserId, date, timezone, calendarFilter, now, live, mirror })` —
  `live` (`listCalendars` + `listAppointments` per calendar over `getDayBounds(date, tz)`, assigned-user match,
  calendar filter) is tried first; any error or throw → `mirror` (the `appointments` table for the same window and
  user) with `source: 'mirror'`, `asOf` = the `ghl.appointments` marker's `completedAt` (else the newest `synced_at`
  of the rows shown) and `reason` = the GHL error with no token in it. GHL not configured at all → mirror with
  reason "GoHighLevel is not connected". A live result is cached in memory for 120 s per (user, date, filter); a
  fallback result is never cached, so the next request retries GHL.
- `lib/companion/enrich.ts`: one query joins `contacts` → `stages` → `pipelines` by `ghl_contact_id` for stage name,
  role and pipeline; contacts missing from the mirror are read live (`getContact`, at most 10 per request) and
  otherwise shown as "Unknown contact <id>".
- `GET /api/companion/day?date=YYYY-MM-DD[&user=<app user id>]` (the `user` switch is owner-only: "Viewing as
  Miranda"). `GET /api/companion/me` → the signed-in user, the user being viewed and (owner) the technician list.
- Page: own slim shell (`app/companion/layout.tsx`, no NavBar / StaleSyncBanner / Analyst orb): header "My day ·
  <name>", date (◀ ▶, native date input, Today), counter "N calls · N logged · N need an outcome", source line
  ("Live from GoHighLevel, 10:42 AM" or the amber banner "Showing data from 9:07 AM — GoHighLevel could not be
  reached: <reason>" + Retry), cards (time, client, Consult / Roadmap / calendar name, stage, status chip), Pop out
  button, Settings link, Sign out. Works at 360 px.

**(b)** `/companion` on a weekday: cards in start order; the chip of a call that ended an hour ago reads "Needs
outcome"; the header reads e.g. "5 calls · 0 logged · 3 need an outcome"; the source line says "Live from
GoHighLevel, 10:42 AM". `GET /api/companion/day` → `{ source: 'live', fetchedAt, calls: [...], counts: {...} }`.

**(c)** GHL down / token revoked → the amber banner names the reason and the cards come from the mirror; the API body
carries `source: 'mirror', asOf, reason`. Never a blank list without a reason: no calls AND live OK → "No calls on
<date>"; no GHL user on the login → "No GoHighLevel user is linked to this login — the owner sets it in Setup →
Users" (no cards, no counter).

**(d)** `tests/companion-day.test.ts`: assigned-user match (assignedUserId, users[], neither); the calendar filter;
call type from the calendar; day-boundary events (23:30 local belongs to that day, 00:10 to the next, in
America/Edmonton); every status by the clock; selectCurrent ±10 / next / last; the 2-minute cache (second call does
not hit live; after 120 s it does); the fallback (live throws → mirror rows + `asOf` from the marker + reason;
not cached); enrichment (stage from the mirror, live read for the unknown contact, capped). Live:
`scripts/companion-check.ts` (item 5).

## Item 3 — Pop-out

**(a)** "Pop out" opens a Document Picture-in-Picture window (Chrome 116+, ~360×520, always on top) whose content is
`/companion/popout` in an iframe; without the API it opens a normal popup window with the same page and a clear line
"This browser can't float the brief over other windows — use Chrome 116+". The page: auto-selects the current call
(`selectCurrent`), ◀ ▶ through the day, search (our contacts + live GHL `GET /contacts/?query=`), the brief, and the
disabled outcome area "Logging arrives in stage 2".

- New read-only client calls: `listContactNotes(contactId)` (`GET /contacts/{id}/notes`, Version 2021-07-28,
  `GhlNotesResponseSchema`) and `searchContacts(query)` (`GET /contacts/?locationId&query&limit=8`,
  `GhlContactsSearchResponseSchema`). Both GET; `npm run verify:readonly` unchanged.
- `GET /api/companion/brief?contact=<ghl contact id>[&event=<ghl event id>]` → `{ name, email, phone, callType,
  calendarName, startIso, stage, pipeline, daysInPipeline: { days, since: 'application' | 'contact created' } |
  null, notes: { status: 'ok', items: [{ body, dateAdded, author }] (last 3) } | { status: 'unavailable', reason } }`.
  Days in pipeline = today − the followed-pipeline opportunity's `createdAt` (`ghl_opportunities`), else
  `contacts.opportunity_created_at`, else `contacts.ghl_created_at` (labelled), else null ("not in the mirror yet").
- `GET /api/companion/search?q=` → `{ mirror: [...], live: [...] | { error } }` merged by GHL contact id.
- Auto-advance (item 4 preference): the page re-runs `selectCurrent` every 30 s unless the user pinned a call with
  ◀ ▶ (the pin clears when that call ends).

**(b)** Click Pop out in Chrome → a small always-on-top window with the 10:30 call's brief: name, email, phone,
"Consult · 15-Minute Fit Physician Consult", "Day 4 in pipeline (since application)", "Consult booked ·
[new] Application Pipeline", three notes with dates, and three greyed buttons under "Logging arrives in stage 2".

**(c)** Notes endpoint 401/403 → "Notes unavailable: GHL 403 GET /contacts/…/notes: …" in the notes slot, the rest
of the brief intact. Safari → popup + the can't-float line. No calls today → the window shows the search box and
"No calls on <date>". A contact not in the mirror → stage "not in the mirror yet", days null, the live name.

**(d)** `tests/companion-brief.test.ts`: days-in-pipeline precedence and labels; notes ok / unavailable (reason
carries no token); search merge (mirror + live, dedupe by id, live error reported); `selectCurrent` edge cases.
`tests/ghl-schemas.test.ts` gains the notes / search shapes. Live: Mitchell opens the pop-out over Zoom in
full-screen on Miranda's Mac (cannot be verified here); `npm run verify:readonly` green.

## Item 4 — Settings (`/companion/settings`)

**(a)** `GET/PATCH /api/companion/settings` → `preferences` on the user's row: `calendarIds: string[] | null` (null =
all calendars where she is the assigned user; the page lists GHL's calendars live, falling back to the mirror's
distinct calendars), `timezone` (IANA, default the business zone), `autoAdvance` (default on).
`POST /api/companion/password { current, next }` → scrypt check of the current one, ≥ 10 chars, re-hash. The env
owner has no row: the page says "Sign in with a personal login to save preferences".

**(b)** Unticking "Quick Connect with Miranda" removes those calls from My day on the next load; the saved banner
reads "Preferences saved". Password change → "Password changed" and the next login uses it.

**(c)** Wrong current password → 401 "Current password is wrong"; a short new one → 400 "Use at least 10
characters"; GHL calendars unreachable → the mirror's calendar list with the line "Calendar names from the last sync
(GoHighLevel could not be reached)".

**(d)** Route tests in `tests/companion-auth.test.ts` (preferences round trip, password change, env owner 409).

## Item 5 — tests + proof

- Unit tests above; `tests/rls.test.ts` covers the new table automatically; `npm run check` (typecheck + vitest +
  verify:readonly + build) green.
- `scripts/companion-check.ts` (`npm run companion:check [-- --user <email|ghl user id>]`), read-only, live GHL: for
  the last 5 working days (Mon–Fri up to today, business timezone) it builds (A) the Companion's day through
  `loadMyDay` (live path, the user's calendar filter) and (B) an INDEPENDENT walk — every active GHL calendar, a
  3-day window, events kept when their start falls on the local date and `assignedUserId` / `users[]` names the
  user — and prints per-day counts for A, B and the mirror, then every difference (event id, calendar, time, which
  side). A = B on every day → `PASS`; any difference → `FAIL` with exit 1. The mirror count is INFO (sync lag is
  expected, not a failure).
- Screenshots: `scripts/screenshots.ts` gains `companion-day`, `companion-popout`, `companion-settings` at 1440 px and
  360 px in both themes (demo tenant: the seed adds the onboarding user `miranda@fitflow.demo` / `demo-companion` and
  assigns the demo appointments to `demo-user-miranda`; with no GHL credentials the demo shots show the honest
  mirror banner).
- Report: works / fails / what Mitchell verifies by hand (log in as Miranda; the pop-out over Zoom in full-screen on
  her Mac; `npm run companion:check` on his machine if the token here cannot reach the notes endpoint).

## Order and commits

1. docs: this plan. 2. logins + roles. 3. My day. 4. Pop-out. 5. Settings. 6. companion-check + screenshots +
CLAUDE.md section + report. `npm run check` green between items; nothing pushed.

## Deploy order (for later)

`npm run db:migrate` (0021 is additive: a new table; safe for the deployed code) THEN push. Then Setup → Users → add
Miranda with her GHL user. `APP_PASSWORD` / `AUTH_SECRET` unchanged.
