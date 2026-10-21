# Onboarding Companion — Stage 4 report (2026-10-21): the pop-out redesign (Option A + collapse)

Plan: `docs/companion-stage4-plan.md`. Six commits on `main` after stage 3's `f6f7d00`, NOT pushed; `npm run check`
green at the end (see "Numbers"). The write path is untouched: `lib/companion/log.ts`, `ghlWrite.ts`, the allow-list,
dry run and the `/api/companion/actions*` routes have no diff; `scripts/verify-readonly.sh` unchanged and passing.

## Commits (oldest first)

| commit | item |
|---|---|
| `ee4c567` | 0 — the plan, with the Document PiP probe findings |
| `0300030` | 1 — the expanded layout (header + ONE chip, brief, 2×3 grid, note, last note, fixed footer with the one line; two-step confirm) |
| `a19b36f` | 2 — collapse (only the button; saved state; PiP resize with the corner measured; the in-page fallback panel) |
| `f8ea1e4` | 3 — remember location (size-only `requestWindow`; `scripts/popout-measure.ts`) |
| `7693a8b` | 4 — theme follows the main app live (opener-side MutationObserver → wrapper + iframe) |
| (item 5) | 5 — dev badge hidden, contrast fixes, the screenshot set, this report, CLAUDE.md |

## What works (verified)

1. **Expanded layout, 360×560, never scrolls.** Header 48 px: accent mark · "Today · 2 of 2" · the chip · ‹ › · gear ·
   collapse (far right; the panel host adds ✕ before it). Body: "Consult · 8:45 AM–9:15 AM · Needs outcome", the name
   20 px / 700, chips (stage · "3 d in pipeline" · Open in GHL — a link when the contact has a GoHighLevel page, a
   disabled chip with the reason otherwise). Grid 2×3 of 40 px buttons (the five outcomes + "Move to…", which opens a
   popover with the stage and appointment selects); selected = accent border + accent tint. Note 76 px with "0 / 10"
   → "Note ready". "Last note · Oct 12 · <text>" clamped to two lines. Fixed footer: "Log outcome" (44 px) + ONE line:
   "Pick an outcome and write a note" → "Moves to Pre-Roadmap Booked · marks showed · adds note" (· "dry run — nothing
   sent"). The first click fetches the plan and the button becomes "Confirm: Showed, roadmap booked" beside Cancel; a
   stale stage turns the line amber ("Stage changed to X since you opened this — Continue anyway logs on top of it") and
   the button into "Continue anyway" — the same request id, stage 2's 409 path. After confirm the body shows the three
   per-step checks with Retry on the failing step; the footer shows "Undo (4:58)" + "Log another". The screenshot run
   asserts `document.scrollHeight ≤ 560` and no overflowing element for every expanded state (printed per shot:
   "no scroll (560/560)").
2. **ONE status chip.** `statusChip(problems)`: "GHL error" (red) > "Error" (red — a FitFlow API call or the window
   itself) > "Dry run" (amber) > nothing. Clicking it opens a popover listing every problem (red ones first); every
   detail passes `scrubEnvNames` — the demo tenant's own "Add them in Setup or via GHL_API_TOKEN / GHL_LOCATION_ID"
   renders as "… via a server setting / a server setting". No banner remains in the pop-out; the "can't float" sentence
   lives in the gear popover. Sources on the chip: the day failing to load (app), the mirror fallback with its reason
   (ghl), the brief failing (app), notes unavailable (ghl), a live-search failure (ghl), the outcomes failing to load
   (app), a failed / partial log's error (ghl), the auto-advance save failing (app), a refused resize / a moved corner /
   a theme-sync failure (window), dry run (dry_run).
3. **Collapse — only the button.** `collapseReducer` flips on `toggle_button` and on nothing else (header click,
   double-click, a new call, hover, focus, logging — all tested); the markup has exactly one control with
   `aria-expanded` and `aria-label` "Collapse" / "Expand" (tested); no `onDoubleClick` exists in the pop-out
   (source-guarded). The state is saved under `companion_popout_collapsed` (try/catch; a throwing storage reads as
   expanded and puts "could not be saved" on the chip) and read through `useSyncExternalStore`, so the server renders
   expanded and the client re-reads after hydration (the first build had a hydration mismatch — fixed) and two open
   views agree. Collapsed = the header row as a bar: name · time · "next: Jo 3:00" / "last call" · chip · expand.
4. **Document PiP resize holds the corner.** Inside the click, `window.top.resizeTo(360, inner + titleBar)`; the corner
   is read before and 250 ms after and logged in dev as `[companion pop-out] toggle → collapsed · before (x, y) · after
   (x, y) · held`. **Chrome 155, four quadrants × 10 toggles: Δx = Δy = 0 on all 40** (table below). Chrome's minimum
   inner height is **66 px** (`resizeTo(360, 48)` and `(360, 82)` both land on 66), so the collapsed bar is 66 px tall
   with the 48 px row centred — the spec's "use the minimum and report it".
5. **Fallback panel (no Document PiP).** An in-page floating panel (portal, `--z-overlay`), draggable by its header
   (buttons inside the header keep their own behaviour), collapsing from the bottom so `top/left` never change,
   position saved under `companion_popout_pos` on drag end and clamped on `resize`. Driven in headless Chromium: drag
   (1064, 324) → (764, 124) and saved; header click + double-click → no toggle; collapse → height 48 at the same
   corner; reload → position AND collapsed state restored; viewport 1440×900 → 700×500 → clamped to (340, 0).
   `/companion?popout=panel` opens it on load (the screenshot; a bookmark). A refused PiP request (no gesture, a policy)
   is named under the Pop out button, logged, and the panel opens instead.
6. **Remember location.** `requestWindow` is called with only `{ width, height }` for the saved state — never
   `preferInitialWindowPlacement`. Bundled Chromium 131 (the only Chrome AppleScript can move): opened at (1137, 373),
   **moved by System Events to (977, 253), closed, reopened at (977, 253) 360×560 — remembered.** Chrome 155 (which a
   Playwright launch hides from System Events): closed at (1137, 373), reopened at (1137, 373) — consistent, not a
   proof by itself. Probe 2026-10-21: reopening with a DIFFERENT requested size re-places the window at Chrome's default
   spot, which is why the opener asks for the saved state's size (66 collapsed / 560 expanded).
7. **Theme follows the app, live.** The opener copies `data-theme` + `color-scheme` into the PiP wrapper `<html>` and
   the iframe's `<html>` on open, on iframe load and on every mutation of its own `<html data-theme>`; the wrapper's
   body is painted from the computed `--bg-canvas` (no hex anywhere in the pop-out). Real Chrome: 100 ms after the
   app's toggle → opener dark, wrapper `data-theme="dark"` with `rgb(13, 14, 16)`, iframe dark with the same canvas;
   back to light likewise. System mode: the ThemeProvider writes the attribute when the OS flips, so the observer
   fires — covered by the unit test (a fake observer; a data-theme change reaches every target; a throwing target is
   reported, never thrown; no MutationObserver → the one-time copy + "will not follow changes" on the chip).
8. **Dev badge.** `/companion/popout` renders `<style>nextjs-portal{display:none !important}</style>`; the screenshot
   run reads the element's computed display: `none` in every pop-out shot.
9. **Never silent.** A refused resize → chip "Error" ("resize to the 66 px bar refused — the window stayed at
   360×560") + `console.error`; a corner that moved > 2 px → chip ("The window moved 0 × 14 px on collapse …"); a
   theme-sync failure → `postMessage` into the pop-out → chip + `console.error`; a GHL failure → "GHL error" with the
   server's sentence.
10. **Contrast ≥ 4.5:1 in both themes** (WCAG, alpha composited over the canvas; the first pass found text-tertiary
    3.66:1 light, accent-on-tint 3.90:1 dark, white-on-accent 3.81:1 dark and white-on-warning 2.04:1 dark — all
    changed: readable text is `--text-secondary`, labels on accent / warning are `--text-inverse`, the chip and the
    Open in GHL chip carry no tint, the selected cell keeps `--text-primary`, "Logged" uses `--positive-text`):

| pair | light | dark |
|---|---|---|
| header title · text-primary on surface-overlay | 19.45 | 16.74 |
| collapsed bar time + "next:" · text-secondary on overlay | 7.13 | 7.14 |
| call line, last note, footer line, counters · text-secondary on canvas | 7.13 | 7.42 |
| status word Up next · info on canvas | 4.63 | 6.85 |
| status word Needs outcome · warning on canvas | 5.02 | 9.46 |
| status word Logged / result title · positive-text on canvas | 5.85 | 9.82 |
| status word Failed · danger on canvas | 5.42 | 6.66 |
| grid label · text-primary on surface-raised | 19.45 | 15.98 |
| selected grid label · text-primary on accent tint | 16.93 | 13.39 |
| Log outcome / Confirm / Log another · text-inverse on accent | 6.17 | 5.11 |
| Confirm (dry run) · text-inverse on warning | 5.02 | 9.53 |
| chip GHL error · danger on canvas | 5.42 | 6.66 |
| chip Dry run · warning on canvas | 5.02 | 9.46 |
| popover detail · text-secondary on surface-raised | 7.13 | 6.81 |
| Open in GHL chip · accent on canvas | 6.17 | 5.1 |

## The measurements (`npx tsx scripts/popout-measure.ts`, 2026-10-21 19:42 UTC)

Browser Chrome 155.0.8059.85 · screen work area 1512×944 at (0, 38) (the main display; menu bar 38 px) · 10 toggles per
quadrant · the demo tenant on `http://localhost:3111`. Each quadrant is a fresh Chrome parked there with
`--window-position` / `--window-size` (the flags apply to the PiP window too — a PiP window cannot be moved by script,
and System Events cannot see a Playwright-launched Chrome's windows). Positions are the opener's reading of
`documentPictureInPicture.window.screenX / screenY`; "inner h" is the PiP window's `innerHeight`.

| quadrant | opened at | toggles | before → after (every row) | Δx | Δy | inner h (collapse / expand) | held ≤ 2 px |
|---|---|---|---|---|---|---|---|
| top-left | (24, 62) | 10 | (24, 62) → (24, 62) | 0 | 0 | 66 / 560 | 10 of 10 |
| top-right | (1128, 62) | 10 | (1128, 62) → (1128, 62) | 0 | 0 | 66 / 560 | 10 of 10 |
| bottom-left | (24, 364) | 10 | (24, 364) → (24, 364) | 0 | 0 | 66 / 560 | 10 of 10 |
| bottom-right | (1128, 364) | 10 | (1128, 364) → (1128, 364) | 0 | 0 | 66 / 560 | 10 of 10 |

The full 40-row table (one row per toggle) is what the script prints; every row reads `0 | 0 | yes`. An earlier run
parked the top quadrants at y = 24 — inside the menu bar — and Chrome's FIRST resize clamped the window to y = 38 (Δy 14),
after which every toggle held; the script now parks inside the work area and flags that case explicitly. The bundled
Chromium 131 (2 toggles per quadrant, used only for the AppleScript move) held three quadrants but jumped on the
top-right EXPAND to (302, 386) — a Chromium-131 placement quirk Chrome 155 does not show; Mitchell's Chrome is 155.

Remember location (no launch flags): Chromium 131 — opened (1137, 373), moved by System Events to (977, 253), closed,
reopened at (977, 253) 360×560 — **same place**. Chrome 155 — opened (1137, 373), closed, reopened (1137, 373) — same
place (could not be moved first).

## Numbers

- `npm run check`: typecheck green; vitest **109 files / 1082 tests — 1071 passed, 11 skipped by two suites
  (`analyst-service`, `stripe-incremental`) whose PGlite migration hook hit the 30 s timeout under the parallel load
  of the full run; both pass alone (2 files / 11 tests)**; verify:readonly green (3 entries · 3 paths · assertAllowed
  before transport · own key); `next build` compiled successfully. `tests/companion-popout.test.ts` adds 15 tests: chip priority, env scrub, collapse reducer, storage incl. a
  throwing one, panel position + clamp, header markup, no env names, effect line, next-call label, day title,
  resize refusal, geometry, theme sync ×3).
- Screenshots (`npm run screenshots -- --companion`, both themes, `docs/screens/{light,dark}/`): `companion-popout`
  (expanded), `companion-popout-collapsed` (360×66), `companion-popout-confirm`, `companion-popout-ghl-error` (chip
  popover open), `companion-popout-success / -partial / -dryrun`, `companion-popout-panel` (the fallback over My day),
  plus the stage 1 / 2 / 3 Companion shots.

## What fails, and how it shows

- GoHighLevel unreachable → the day from the mirror; the chip "GHL error" with "GoHighLevel could not be reached:
  <reason> — showing synced data from <time>"; notes "Last note unavailable — see the status chip".
- A step refused by GHL (stage 2's 422 / 4xx) → the result's ✗ with the server's sentence, Retry on that step, the chip
  "GHL error" with the same sentence, the footer line "Partly applied · … — Retry the failing step above".
- `resizeTo` refused or no-op → the layout still collapses; the chip "Error" + console; the window keeps its size.
- The corner moves > 2 px → the chip "Error" naming both positions (never seen on Chrome 155).
- Storage blocked (a private window with site data off) → the collapse works for the session; the chip says it will
  not survive a reopen; the panel logs that its position could not be saved.
- Theme sync target throws (the window closed between the mutation and the copy) → `console.error` + the chip when
  the pop-out is still alive; the next mutation retries.
- No Document PiP (Safari, Firefox, Chrome < 116) → the in-page panel, and the gear says so.

## Not verified by Claude

- **System mode with a real OS flip**: Playwright's `emulateMedia` reaches the opener tab only — the PiP window kept the
  real OS scheme, so the live run could not flip both at once (the opener followed; the iframe correctly showed the real
  OS). The mechanism is unit-tested and the explicit toggle is verified live. Mitchell: pop out in system mode, flip
  macOS appearance, watch both windows.
- The real tenant (GoHighLevel live, a real log through the new footer) — the demo tenant has no GHL credentials, so
  every live screenshot carries the "GHL error" chip for "No GoHighLevel credentials configured".
- Edge / Chrome on Windows (the title-bar delta is measured at run time, so a different chrome height is handled; the
  minimum height may differ and is reported on the chip only if a resize is refused).
- Chrome's own placement when the window is reopened at a DIFFERENT size than it was closed at (the opener avoids it by
  requesting the saved state's size).

## What Mitchell must verify by hand

1. In Chrome: My day → Pop out → collapse / expand ten times in the corner you use; the dev console (of the pop-out
   iframe) prints the before/after corner for each toggle. Drag the window, close it, Pop out again — same place.
2. Switch the app's theme with the pop-out open; set "system" and flip macOS appearance.
3. Log one real outcome through the new footer (dry run ON): Log outcome → "Confirm: …" → the three dry-run checks →
   Undo.
4. In Safari (or Chrome with the PiP window refused): the in-page panel, drag it, collapse it, reload.

## Design notes

- **Search moved into the gear popover** ("Find someone") — the spec's header is exhaustive and has no room for a
  search box; picking a person shows "From search · back to the call".
- The gear popover also carries Auto-advance (saved through `/api/companion/settings`; the team-password owner sees
  why it is disabled), the window mode sentence (floating / "can't float — use Chrome 116+" / plain tab) and the My day
  / Companion settings links (new tab, so the window never navigates away).
- The panel host adds a ✕ before the collapse button (a floating window has Chrome's own close).
- `?popout=panel` on My day opens the panel on load; `?host=pip` on the pop-out page selects the PiP host (set by the
  opener); `?float=0` still means a plain tab.
- The PiP wrapper document's background is the opener's computed `--bg-canvas` at open time and on every theme change —
  the old literal `#0f1013` is gone.
