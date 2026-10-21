/**
 * Companion stage 4 — measures the floating pop-out window in REAL Chrome (Playwright `channel: 'chrome'`; the
 * bundled Chromium with `--chromium`): for each screen quadrant, parks the window there, clicks the real collapse
 * button ten times and records screenX / screenY before and after every toggle (the top-left corner must hold within
 * 2 px), then closes the window and reopens it to prove Chrome brings it back where it was. Prints a markdown table.
 *
 *   BASE_URL=http://localhost:3111 npx tsx scripts/popout-measure.ts [--out docs/…md] [--toggles 10] [--chromium]
 *
 * Needs a dev server on the demo tenant (auth off) with calls on the day. Nothing is written to GoHighLevel — the
 * script only opens, toggles, closes and reopens the window. Chrome windows WILL appear on screen while it runs.
 *
 * How the quadrants are reached: a Document PiP window cannot be moved by script (`moveTo` is a no-op) and
 * Playwright-launched Chrome windows are invisible to AppleScript, but Chrome's `--window-position` / `--window-size`
 * launch flags apply to the PiP window too (probed 2026-10-21), so each quadrant is a fresh launch parked there.
 */
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('--out');
const TOGGLES = Number(arg('--toggles') ?? 10);
const CHANNEL = process.argv.includes('--chromium') ? undefined : 'chrome';
const WINDOW = { width: 360, height: 594 }; // the expanded OUTER size (560 inner + Chrome's 34 px PiP title bar)

/**
 * macOS + the bundled Chromium only: System Events can see Chromium's windows (not a Playwright-launched Chrome's), so
 * the reopen test can MOVE the window first — the only way to prove Chrome remembers a position rather than the flag.
 */
function moveWindowByAppleScript(dx: number, dy: number): { ok: true; position: string } | { ok: false; reason: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not macOS' };
  const script = `tell application "System Events"
  repeat with p in (every process whose name is "Chromium" or name is "Google Chrome")
    if exists (window "FitFlow Companion" of p) then
      set w to window "FitFlow Companion" of p
      set {x, y} to position of w
      set position of w to {x + ${dx}, y + ${dy}}
      return (position of w as list) as string
    end if
  end repeat
end tell
return "none"`;
  try {
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15_000 }).trim();
    return out === 'none' ? { ok: false, reason: 'System Events cannot see the window (a Playwright-launched Chrome; use --chromium)' } : { ok: true, position: out };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

interface Geo {
  x: number;
  y: number;
  ow: number;
  oh: number;
  iw: number;
  ih: number;
}

const geoFromOpener = (page: Page): Promise<Geo | null> =>
  page.evaluate(() => {
    const w = (window as unknown as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window;
    return w ? { x: w.screenX, y: w.screenY, ow: w.outerWidth, oh: w.outerHeight, iw: w.innerWidth, ih: w.innerHeight } : null;
  });

async function findDay(): Promise<string> {
  const r = await fetch(`${BASE}/api/companion/day`);
  if (!r.ok) throw new Error(`${BASE}/api/companion/day answered ${r.status} — start the dev server on the demo tenant (DATABASE_URL= COMPANION_PREVIEW=1 npx next dev -p 3111)`);
  const d = (await r.json()) as { today: string; calls: unknown[] };
  if (d.calls.length) return d.today;
  for (let back = 1; back <= 60; back += 1) {
    const day = new Date(Date.UTC(Number(d.today.slice(0, 4)), Number(d.today.slice(5, 7)) - 1, Number(d.today.slice(8, 10)) - back)).toISOString().slice(0, 10);
    const x = (await (await fetch(`${BASE}/api/companion/day?date=${day}`)).json()) as { calls: unknown[] };
    if (x.calls.length) return day;
  }
  return d.today;
}

async function openPopOut(browser: Browser, page: Page) {
  await page.getByRole('button', { name: 'Pop out' }).click();
  const deadline = Date.now() + 8000;
  let pip: Page | undefined;
  while (Date.now() < deadline && !pip) {
    pip = browser.contexts().flatMap((c) => c.pages()).find((p) => p !== page && p.frames().some((f) => f.url().includes('/companion/popout')));
    if (!pip) await page.waitForTimeout(100);
  }
  if (!pip) throw new Error('the floating window did not appear (Document Picture-in-Picture unavailable?)');
  const frame = pip.frames().find((f) => f.url().includes('/companion/popout'))!;
  await frame.waitForSelector('[data-testid=popout-root]', { timeout: 15_000 });
  await page.waitForTimeout(600);
  return { pip, frame };
}

async function main() {
  const date = await findDay();
  const work: { w: number; h: number; top: number; left: number; version: string } = await (async () => {
    // Parked on the main display (a multi-monitor Mac's default window may sit on another screen with a different work
    // area); `viewport: null`, or Playwright emulates `screen` as 1280×720 at (0, 0) and the menu bar is invisible.
    const b = await chromium.launch({ channel: CHANNEL, headless: false, args: ['--window-position=100,100', '--window-size=600,400'] });
    const p = await (await b.newContext({ viewport: null })).newPage();
    const s: { w: number; h: number; top: number; left: number } = await p.evaluate(() => ({ w: window.screen.availWidth, h: window.screen.availHeight, top: (window.screen as unknown as { availTop?: number }).availTop ?? 0, left: (window.screen as unknown as { availLeft?: number }).availLeft ?? 0 }));
    const version = b.version();
    await b.close();
    return { ...s, version };
  })();
  const pad = 24;
  const quadrants = [
    { name: 'top-left', x: work.left + pad, y: work.top + pad },
    { name: 'top-right', x: work.left + work.w - WINDOW.width - pad, y: work.top + pad },
    { name: 'bottom-left', x: work.left + pad, y: work.top + work.h - WINDOW.height - pad },
    { name: 'bottom-right', x: work.left + work.w - WINDOW.width - pad, y: work.top + work.h - WINDOW.height - pad },
  ];
  const lines: string[] = [];
  const say = (s: string) => {
    console.log(s);
    lines.push(s);
  };
  say(`# Pop-out collapse measurements — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  say('');
  say(`Browser ${CHANNEL ?? 'chromium'} ${work.version} · screen work area ${work.w}×${work.h} at (${work.left}, ${work.top}) · ${TOGGLES} toggles per quadrant · day ${date} · ${BASE}`);
  say('');
  let allHeld = true;
  let minInner: number | null = null;
  let reopenOk = true;
  for (const q of quadrants) {
    const browser = await chromium.launch({ channel: CHANNEL, headless: false, args: [`--window-position=${q.x},${q.y}`, `--window-size=${WINDOW.width},${WINDOW.height}`] });
    try {
      const context = await browser.newContext({ viewport: null });
      await context.addInitScript(() => {
        try {
          localStorage.setItem('companion_popout_collapsed', '0');
        } catch {
          /* ignore */
        }
      });
      const page = await context.newPage();
      await page.goto(`${BASE}/companion?date=${date}`, { waitUntil: 'networkidle' });
      const { pip, frame } = await openPopOut(browser, page);
      const start = await geoFromOpener(page);
      say(`## ${q.name} — window opened at (${start?.x}, ${start?.y}), ${start?.iw}×${start?.ih} inner / ${start?.ow}×${start?.oh} outer`);
      say('');
      say('| # | action | before x,y | after x,y | Δx | Δy | inner h after | held ≤ 2 px |');
      say('|---|---|---|---|---|---|---|---|');
      for (let i = 1; i <= TOGGLES; i += 1) {
        const before = (await geoFromOpener(page))!;
        await frame.click('[data-testid=popout-collapse]');
        await pip.waitForTimeout(450);
        const after = (await geoFromOpener(page))!;
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const held = Math.abs(dx) <= 2 && Math.abs(dy) <= 2;
        if (!held) allHeld = false;
        const collapsedNow = i % 2 === 1;
        if (collapsedNow) minInner = minInner === null ? after.ih : Math.min(minInner, after.ih);
        say(`| ${i} | ${collapsedNow ? 'collapse' : 'expand'} | ${before.x}, ${before.y} | ${after.x}, ${after.y} | ${dx} | ${dy} | ${after.ih} | ${held ? 'yes' : 'NO'} |`);
        if (!held && i === 1 && before.y < work.top) say(`| | | | | | | | ↑ the launch flag parked the window above the work area (y ${before.y} < ${work.top}); Chrome's first resize clamped it — not anchoring |`);
      }
      await pip.close().catch(() => undefined);
      say('');
    } finally {
      await browser.close();
    }
  }
  // Item 3 — remember location. A fresh launch WITHOUT position flags (a flag re-parks every new window, the reopened
  // one included): open, move the window (AppleScript sees the bundled Chromium's windows, not a Playwright-launched
  // Chrome's), close, reopen, compare. With Chrome the window cannot be moved by script, so the result is "consistent".
  {
    const browser = await chromium.launch({ channel: CHANNEL, headless: false });
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(`${BASE}/companion?date=${date}`, { waitUntil: 'networkidle' });
      const first = await openPopOut(browser, page);
      const opened = (await geoFromOpener(page))!;
      const moved = moveWindowByAppleScript(-160, -120);
      await page.waitForTimeout(600);
      const beforeClose = (await geoFromOpener(page))!;
      await first.pip.close();
      await page.waitForTimeout(800);
      const second = await openPopOut(browser, page);
      const after = (await geoFromOpener(page))!;
      const same = Math.abs(after.x - beforeClose.x) <= 2 && Math.abs(after.y - beforeClose.y) <= 2 && after.ih === beforeClose.ih;
      reopenOk = same;
      say('## Remember location (no launch flags)');
      say('');
      say(`Opened at (${opened.x}, ${opened.y}) · ${moved.ok ? `moved by System Events to (${beforeClose.x}, ${beforeClose.y})` : `not moved (${moved.reason}) — still at (${beforeClose.x}, ${beforeClose.y})`} · closed · reopened at (${after.x}, ${after.y}) ${after.iw}×${after.ih} — ${same ? (moved.ok ? 'SAME PLACE: the position is remembered' : 'same place (consistent with a remembered position; the window could not be moved first, so not a proof)') : 'DIFFERENT — the position was NOT restored'}`);
      say('');
      await second.pip.close().catch(() => undefined);
    } finally {
      await browser.close();
    }
  }
  say(`## Result: top-left corner ${allHeld ? 'held within 2 px on every toggle' : 'MOVED on at least one toggle'} · collapsed inner height ${minInner ?? '?'} px (Chrome's minimum) · reopen ${reopenOk ? 'restores position and size' : 'does NOT restore the position'}`);
  if (OUT) {
    fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
    console.log(`\nwritten to ${OUT}`);
  }
  process.exit(allHeld && reopenOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
