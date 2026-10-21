# Onboarding Companion — Stage 4 plan (2026-10-21): the pop-out redesign (Option A + collapse)

The pop-out becomes one 360×560 window that never scrolls, with one status chip instead of stacked banners, a
2×3 outcome grid, a fixed "Log outcome" footer whose one line says exactly what will happen, and a collapse
button that shrinks the window to a bar without moving its top-left corner. Theme follows the main app live.
**Nothing in the write path changes**: `lib/companion/log.ts`, `ghlWrite.ts`, the allow-list, dry run and the
four `/api/companion/actions*` routes are untouched; `scripts/verify-readonly.sh` stays as it is. Not pushed.

Order of work, one commit each: 0 plan → 1 expanded layout → 2 collapse → 3 remember location → 4 theme →
5 badge + never-silent + screenshots + measurements + report. `npm run check` green between commits.

## What the probes found first (real Chrome 155 through Playwright `channel: 'chrome'`, 2026-10-21)

These decide the design; the stage report repeats them with the full table.

- `documentPictureInPicture.requestWindow({ width: 360, height: 560 })` opens a 360×560 **inner** window
  (outer 360×594: Chrome's PiP title bar is 34 px) at the bottom-right of the opener's display.
- `window.resizeTo(w, h)` on the PiP window sets the **outer** size and works from inside the iframe
  (`window.top.resizeTo`, the click's activation propagates) and from the opener. The window's **minimum
  inner height is 66 px** (outer 100): `resizeTo(360, 48)` and `resizeTo(360, 82)` both land on 66. So the
  collapsed bar is **66 px tall** (Chrome's minimum; the spec allows "use the minimum and report it").
- Across resizes at the default placement the top-left corner **did not move** (x 1137 / y 373 before and
  after every toggle). Item 5's script measures the four quadrants ten times each.
- `moveTo` / `moveBy` on a PiP window are silent no-ops — the page cannot correct a shifted window.
- Closing and reopening WITHOUT `preferInitialWindowPlacement` gave the **same position and size**
  (1137, 373, 360×560). Reopening with a DIFFERENT requested size re-placed the window (bottom-right anchor),
  so the opener always requests the size that matches the saved collapsed state.
- The PiP top window's `opener` is the opener page (`window.top.opener`); the iframe's own `opener` is null.
- Playwright reaches the PiP window as a second `Page` (frames: `about:blank` + the iframe), so the collapse
  button can be clicked for real and `screenX/Y` read from both sides.
- `--window-position` / `--window-size` launch flags apply to the PiP window too — the measurement script
  uses them to park the window in each quadrant (AppleScript cannot see Playwright-launched Chrome windows).

## Shared design

- **One pure state module** `lib/companion/popoutState.ts` (tested in `tests/companion-popout.test.ts`):
  - `statusChip(problems)` — problems are `{ kind: 'ghl' | 'app' | 'window' | 'dry_run', detail }`; the chip is
    the top priority: `ghl` → **"GHL error"** (red) > `app` / `window` → **"Error"** (red) > `dry_run` →
    **"Dry run"** (amber) > nothing. The popover lists every problem's detail (newest first), each through
    `scrubEnvNames` (an `UPPER_SNAKE` token becomes "a server setting" — env var names never reach the window).
  - `COLLAPSED_KEY = 'companion_popout_collapsed'`, `PANEL_POS_KEY = 'companion_popout_pos'`;
    `readCollapsed` / `writeCollapsed` / `readPanelPos` / `writePanelPos` over a `StorageLike`, every call in
    try/catch (a throwing storage reads as not collapsed / no position and never throws).
  - `collapseReducer(collapsed, event)` — flips ONLY on `{ type: 'toggle_button' }`; `header_click`,
    `header_dblclick`, `new_call`, `hover`, `focus`, `logged` return the same state.
  - `effectLine(outcome, { hasCall, dryRun })` — "Moves to Enrolled · marks showed · adds note",
    "Stage unchanged · marks no-show · adds note", "… · marks the deal lost", "… · dry run — nothing sent";
    with nothing picked: "Pick an outcome and write a note".
  - `nextCallLabel(calls, index, tz)` → "next: Jo 3:00" (first name, no meridiem) or "last call".
  - `pipOuterHeight(collapsed, chromeDelta)` (inner 560 / 48 + the measured title-bar delta),
    `COLLAPSED_INNER_MIN = 66` (Chrome's floor), `clampPanelPos(pos, size, viewport)`, `moveDelta(before, after)`
    → `{ dx, dy, held }` (held = both within 2 px).
- **Theme sync** `lib/companion/popoutTheme.ts#startThemeSync({ source, targets, observe, paint, onError })`:
  copies `data-theme` + `color-scheme` from the opener's `<html>` to every target root on start and on every
  mutation (the default `observe` is a `MutationObserver` with `attributeFilter: ['data-theme']`; tests inject a
  fake); `paint(theme)` lets the opener colour the PiP wrapper document from the computed `--bg-canvas` token.
  A throwing target is reported through `onError` (→ the chip + `console.error`), never thrown.
- **Hosts.** `PopOutView` takes a `host`: `pip` (inside the Document PiP iframe; resize = `window.top.resizeTo`),
  `panel` (the in-page floating panel; resize = the panel's height, drag by header, close button),
  `tab` (a plain tab, `?float=0`: collapse only folds the layout). The route `/companion/popout` detects
  `pip` from `?host=pip` set by the opener; everything else is `tab`.
- **Search** moves from a permanent box into the settings popover ("Find someone") — the header has no room
  for it and the spec's header is exhaustive. Noted in the report.
- Tokens only: every colour is a `var(--…)`; the PiP wrapper's background is read from the opener's computed
  `--bg-canvas` (no hex). Contrast is checked for the chip, the footer line, the collapsed bar and the grid in
  both themes (the report lists the ratios).

## Item 1 — expanded layout (360×560, never scrolls)

- (a) `components/companion/PopOutView.tsx` replaces the body of `PopOut.tsx`; `LogPanel.tsx` becomes the hook
  `useOutcomeLog.ts` (the same fetches, byte-identical bodies: plan → confirm → result; retry; undo) with the
  small render pieces `OutcomeGrid`, `NoteField`, `ResultSteps`, `LogFooter`. Layout: header 48 px (accent mark ·
  "Today · 2 of 4" · chip · ‹ › · gear · collapse) → body ("Roadmap · 1:45–2:45 PM · Up next", the name
  20 px / 700, chips: stage · N days in pipeline · Open in GHL) → 2×3 grid of 40 px outcome buttons (the five
  outcomes + "Move to…", selected = accent border + accent tint, unavailable = disabled with the reason as
  title) → the note (76 px) with "4 / 10" → "Last note · Oct 12 · <text>" (two lines, clamped) → fixed footer:
  "Log outcome" (44 px) + ONE line. Two-step confirm: the first click fetches the plan and the button becomes
  "Confirm: <outcome>" beside Cancel; the line then carries the plan (stale stage → "Stage changed to X —
  Confirm continues anyway"; dry run → "· dry run — nothing sent"). After confirm the body shows the three
  per-step checks (✓ / ✗ / –) with Retry on the failing step; the footer shows Undo (countdown) + Log another.
- (b) Works: at 360×560 `document.documentElement.scrollHeight <= 560` (asserted by the screenshot run, printed
  per shot); the footer never moves; the chip is absent on a clean live day with dry run off.
- (c) Fails: a GHL fallback (`day.source = 'mirror'`), notes unavailable, a live-search error or a failed log step
  → the red "GHL error" chip with the detail in its popover; a FitFlow API error (day, outcomes, brief) → "Error";
  dry run → amber. No banner anywhere; the "can't float" sentence lives in the settings popover.
- (d) Verify: `tests/companion-popout.test.ts` (chip priority, env-name scrub, effect line, next-call label,
  static markup of the header: exactly one `aria-expanded` control, no `onDoubleClick`, no env names);
  screenshots `companion-popout` (expanded), `companion-popout-confirm`, `companion-popout-ghl-error`
  (`?preview=ghl_error` — a new canned state with the chip popover open), the existing `success / partial /
  dryrun` states re-skinned.

## Item 2 — collapse (only the top-right button)

- (a) Collapsed = the header row as a bar: name · time · "next: Jo 3:00" · chip · expand. The button has
  `aria-label` "Collapse" / "Expand" and `aria-expanded`; nothing else dispatches `toggle_button`. PiP: inside the
  click handler `window.top.resizeTo(360, pipOuterHeight(collapsed, delta))`, `delta = top.outerHeight −
  top.innerHeight`; `screenX/Y` are read before and 250 ms after and, outside production, logged as
  `[companion pop-out] toggle → collapsed · before (x, y) · after (x, y) · held`. A shift beyond 2 px is a `window`
  problem on the chip (and the report decides whether to ship — see item 5). Panel: height 560 ↔ 48 with
  `top/left` fixed, so the top-left never moves. The state is saved under `companion_popout_collapsed`.
- (b) Works: ten toggles in each quadrant hold x and y within 2 px; the collapsed PiP is 66 px inner (Chrome's
  minimum) with the 48 px bar vertically centred; reopening a window closed while collapsed opens collapsed.
- (c) Fails: `resizeTo` throwing or the window not changing size → the chip "Error" with the detail
  ("resize to 360×100 refused: …"), the layout still collapses, `console.error` carries the same text.
- (d) Verify: `collapseReducer` + the storage tests; the screenshot `companion-popout-collapsed` (localStorage
  pre-set); the measurement table from item 5's script.

## Item 3 — remember location

- (a) PiP: `requestWindow` is called with ONLY `width` / `height` (the saved state's size) — no
  `preferInitialWindowPlacement` — so Chrome reopens where it was. Panel: `companion_popout_pos` saved on drag end,
  clamped on `resize` so it is always on screen; default position bottom-right of the viewport.
- (b) Works: move → close → reopen lands on the same `screenX/Y` (the script prints both).
- (c) Fails: a Chrome that re-places the window is reported with both positions in the table, not hidden.
- (d) Verify: `scripts/popout-measure.ts` step "reopen"; `clampPanelPos` test.

## Item 4 — theme follows the main app, live

- (a) The opener (`PopOutButton`) copies `data-theme` into the PiP wrapper `<html>` and the iframe's `<html>` on
  open and on every change of its own `<html data-theme>` (`startThemeSync`, `MutationObserver`); "system" mode is
  covered because the ThemeProvider writes the attribute on the OS change. The wrapper's background is the
  computed `--bg-canvas`. The pop-out page's own ThemeProvider keeps reading the same localStorage, so the two
  never disagree; the observer makes the change instantaneous.
- (b) Works: toggling the theme in the app recolours the open pop-out within one frame.
- (c) Fails: a target that throws (the iframe not yet loaded, a closed window) → `onError` → the chip "Error"
  via `postMessage` into the pop-out + `console.error`; the next mutation retries.
- (d) Verify: the theme-sync unit test (fake observer: a `data-theme` change reaches every target; a throwing
  target reports, never throws); the dark/light screenshot pairs.

## Item 5 — badge, never silent, proof

- (a) `/companion/popout` renders `<style>nextjs-portal{display:none}</style>` (the dev indicator's host element);
  verified in dev by querying the element's computed display. Every failure path above ends on the chip and in
  the console. `scripts/popout-measure.ts` (Playwright headed, Chrome channel, falls back to Chromium): for each
  quadrant launches Chrome parked there, opens the real pop-out from `/companion` on the demo tenant, toggles the
  real button ten times, records `screenX/Y` before/after from the opener (`documentPictureInPicture.window`),
  then closes and reopens for item 3, and prints a markdown table + the collapsed inner height.
  `scripts/screenshots.ts --companion` adds `companion-popout-collapsed`, `companion-popout-ghl-error`,
  `companion-popout-panel` (the fallback panel on `/companion` — headless Chromium has no Document PiP, so the
  panel is the natural path) and asserts no-scroll at 360×560.
- (b) Works: `npm run check` green; screenshots in `docs/screens/{light,dark}`; the table in
  `docs/companion-stage4-report.md` with every quadrant held within 2 px; the report lists the commits.
- (c) Fails: a quadrant that cannot be held → the report says so with the numbers and the collapse ships
  disabled for PiP (the button folds the layout only) — Mitchell decides.
- (d) Verify: `npm run check`; `npx tsx scripts/popout-measure.ts`; `npm run screenshots -- --companion`.
