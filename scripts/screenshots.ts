/**
 * Playwright screenshot harness — walks every tab in both themes.
 *
 *   npm run screenshots            # against http://localhost:3000 (start `next dev` first)
 *   BASE_URL=http://localhost:3111 npm run screenshots
 *   npm run screenshots -- --explain-audit   # only the audit: every glossary key must appear as [data-explain] on the pages
 *   npm run screenshots -- --companion       # only the Onboarding Companion: My day, the pop-out, settings (desktop + 360 px)
 *
 * Output: docs/screens/{light,dark}/{page}.png (full page, 1440px wide).
 * Theme is forced by stamping data-theme on <html> before each capture, the
 * same attribute ThemeProvider uses, so the shots reflect real token values.
 *
 * Analyst (Wave 2 item 8): the panel's states — launcher, welcome, thinking, answer, explain, error, threads, cost
 * confirmation — at 1440×900 and 390×844 (iPhone) in both themes, as docs/screens/{theme}/analyst-{state}[-mobile].png.
 * They render through the real components from a canned state the dev server serves ONLY when started with
 * ANALYST_PREVIEW=1 (`ANALYST_PREVIEW=1 npm run dev`); without it those captures are skipped with a note. Reduced
 * motion is emulated for the panel shots so the word-fade and the orb are settled. The dark set sits beside
 * docs/fitflow-analyst-demo.html at the same size.
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { GLOSSARY_KEYS } from '../lib/metrics/glossary';
import { CAMPAIGN_COLUMN_KEYS, TIME_IN_STAGE_ROLES } from '../lib/analyst/explainSurfaces';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = path.join(process.cwd(), 'docs', 'screens');

/** The GHL / Stripe backfill start (settings.backfill_from) → today: long enough to include failed / refunded rows. */
const SINCE_BACKFILL = `start=2026-06-01&end=${new Date().toISOString().slice(0, 10)}`;

const PAGES: Array<{ name: string; path: string; settle?: number; currency?: 'CAD' | 'USD' }> = [
  { name: 'command-center', path: '/?range=last_30_days&compare=previous_period' },
  { name: 'scorecard', path: '/scorecard?range=last_week&compare=previous_period' },
  { name: 'funnel', path: '/funnel?range=last_30_days&compare=previous_period' },
  { name: 'ads', path: '/ads?range=last_30_days&compare=previous_period' },
  { name: 'revenue', path: '/revenue?range=last_30_days&compare=previous_period' },
  // C1 / M3: converted + original amounts, the FX note and the excluded-payments reconciliation footer.
  { name: 'revenue-since-backfill', path: `/revenue?range=custom&${SINCE_BACKFILL}&compare=off` },
  // 1b: the same view with the business-wide reporting currency flipped to USD (restored afterwards).
  { name: 'revenue-usd', path: `/revenue?range=custom&${SINCE_BACKFILL}&compare=off`, currency: 'USD' },
  { name: 'clients', path: '/clients' },
  { name: 'client-profile', path: '__first_client__' },
  { name: 'reports', path: '/reports' },
  { name: 'setup', path: '/setup' },
  { name: 'search', path: '/?open_search=1' },
  { name: 'login', path: '/login' },
];

const ANALYST_STATES = ['welcome', 'thinking', 'answer', 'explain', 'error', 'threads', 'confirm'] as const;
const MOBILE = { width: 390, height: 844 };
/** The demo-seeded pages the explain audit walks (every glossary key must have a button on one of them). */
const AUDIT_PAGES = ['/?range=last_30_days&compare=previous_period', '/scorecard?range=last_week&compare=previous_period', '/funnel?range=last_30_days&compare=previous_period', '/funnel?range=last_30_days&mode=period', '/ads?range=last_30_days&compare=previous_period', '/revenue?range=last_30_days&compare=previous_period'];

async function main() {
  const auditOnly = process.argv.includes('--explain-audit');
  const companionOnly = process.argv.includes('--companion');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (auditOnly) {
    const ok = await explainAudit(page);
    await browser.close();
    process.exit(ok ? 0 : 1);
  }
  if (companionOnly) {
    await captureCompanion(browser);
    await browser.close();
    return;
  }

  // Resolve the first client id for the profile shot.
  const res = await page.request.get(`${BASE}/api/clients?limit=1`);
  const first = (await res.json()) as { rows?: Array<{ id: string }> };
  const clientId = first.rows?.[0]?.id;

  // The reporting currency is ONE business-wide setting: flip it only for the
  // captures that ask, and always put the original back.
  const setCurrency = (c: 'CAD' | 'USD') => page.request.post(`${BASE}/api/currency`, { data: { reportingCurrency: c } });
  const original = ((await (await page.request.get(`${BASE}/api/currency`)).json()) as { reporting?: 'CAD' | 'USD' }).reporting ?? 'CAD';

  try {
    await capture(page, context, clientId, setCurrency, original);
    await captureAnalyst(browser);
    await captureCompanion(browser);
  } finally {
    await setCurrency(original);
  }

  await browser.close();
}

/** Every [data-explain] key across the pages vs the glossary: the Playwright side of tests/explain-coverage.test.ts. */
async function explainAudit(page: import('playwright').Page): Promise<boolean> {
  const seen = new Set<string>();
  for (const p of AUDIT_PAGES) {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    for (const k of await page.$$eval('[data-explain]', (els) => els.map((e) => e.getAttribute('data-explain') ?? ''))) if (k) seen.add(k);
  }
  // Columns the campaign table shows only when "Displayed metrics" ticks them, time-in-stage roles with no move in the
  // range and the previous-leads row (only with parked leads) are wired but data-dependent: reported, not a failure.
  const dataDependent = new Set<string>([...CAMPAIGN_COLUMN_KEYS, 'previous_leads', ...TIME_IN_STAGE_ROLES.map((r) => `time_in_${r}`)]);
  const missing = GLOSSARY_KEYS.filter((k) => !seen.has(k));
  const hard = missing.filter((k) => !dataDependent.has(k));
  const soft = missing.filter((k) => dataDependent.has(k));
  console.log(`explain audit: ${seen.size} keys with a "What does this mean?" button across ${AUDIT_PAGES.length} pages · ${hard.length} glossary key(s) with no button${hard.length ? `: ${hard.join(', ')}` : ''}${soft.length ? ` · ${soft.length} wired but not shown by this data / these displayed metrics: ${soft.join(', ')}` : ''}`);
  return hard.length === 0;
}

/** The panel's states at desktop and iPhone width, both themes — only when the server answers the preview route. */
async function captureAnalyst(browser: import('playwright').Browser) {
  const probe = await (await browser.newPage()).request.get(`${BASE}/api/analyst/preview?state=welcome`);
  if (!probe.ok()) {
    console.log(`– analyst-* skipped: /api/analyst/preview answered ${probe.status()} — start the server with ANALYST_PREVIEW=1 to capture the panel states`);
    return;
  }
  for (const theme of ['light', 'dark'] as const) {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? MOBILE : { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', isMobile: mobile, hasTouch: mobile });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('fitflow-theme', t);
        } catch {
          /* ignore */
        }
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      const page = await context.newPage();
      const suffix = mobile ? '-mobile' : '';
      // The launcher: the Command Center with the orb, panel closed.
      await page.goto(`${BASE}/?range=last_30_days&compare=previous_period`, { waitUntil: 'networkidle' });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, theme, `analyst-launcher${suffix}.png`), fullPage: false });
      console.log(`✓ ${theme}/analyst-launcher${suffix}.png`);
      for (const state of ANALYST_STATES) {
        await page.goto(`${BASE}/?range=last_30_days&compare=previous_period&analystPreview=${state}`, { waitUntil: 'networkidle' });
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForSelector('[data-testid="analyst-panel"][data-open="true"]', { timeout: 10_000 });
        await page.waitForTimeout(900); // the slide-in, the orb's first frame
        // The stream follows the latest text (bottom); a still of an answer is read from its top.
        if (state === 'answer' || state === 'explain') {
          await page.$eval('.analyst-stream', (el) => el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
          await page.waitForTimeout(300);
        }
        await page.screenshot({ path: path.join(OUT, theme, `analyst-${state}${suffix}.png`), fullPage: false });
        console.log(`✓ ${theme}/analyst-${state}${suffix}.png`);
      }
      await context.close();
    }
  }
}

/**
 * The Onboarding Companion (stage 1): My day and Settings at 1440 px and 360 px, the pop-out at its real window
 * size (360×520, `float=0` so the page shows the cannot-float line a plain window gets), both themes. The server
 * must run on the demo tenant (auth off → the dev owner views the demo onboarding user); the day captured is today
 * when it has calls, else the nearest earlier day with calls so the cards and the brief are not empty.
 */
async function captureCompanion(browser: import('playwright').Browser) {
  const probePage = await browser.newPage();
  const probe = await probePage.request.get(`${BASE}/api/companion/day`);
  if (!probe.ok()) {
    console.log(`– companion-* skipped: /api/companion/day answered ${probe.status()}`);
    await probePage.close();
    return;
  }
  const today = ((await probe.json()) as { today: string; calls: unknown[] });
  let date = today.today;
  if (today.calls.length === 0) {
    for (let back = 1; back <= 60; back += 1) {
      const d = new Date(Date.UTC(Number(today.today.slice(0, 4)), Number(today.today.slice(5, 7)) - 1, Number(today.today.slice(8, 10)) - back)).toISOString().slice(0, 10);
      const r = (await (await probePage.request.get(`${BASE}/api/companion/day?date=${d}`)).json()) as { calls: unknown[] };
      if (r.calls.length > 0) {
        date = d;
        break;
      }
    }
  }
  await probePage.close();
  const shots: Array<{ name: string; path: string; viewport: { width: number; height: number }; mobile: boolean; fullPage: boolean }> = [
    { name: 'companion-day', path: `/companion?date=${date}`, viewport: { width: 1440, height: 900 }, mobile: false, fullPage: true },
    { name: 'companion-day-mobile', path: `/companion?date=${date}`, viewport: { width: 360, height: 740 }, mobile: true, fullPage: true },
    { name: 'companion-popout', path: `/companion/popout?date=${date}&float=0`, viewport: { width: 360, height: 520 }, mobile: false, fullPage: false },
    { name: 'companion-settings', path: '/companion/settings', viewport: { width: 1440, height: 900 }, mobile: false, fullPage: true },
    { name: 'companion-settings-mobile', path: '/companion/settings', viewport: { width: 360, height: 740 }, mobile: true, fullPage: true },
  ];
  for (const theme of ['light', 'dark'] as const) {
    fs.mkdirSync(path.join(OUT, theme), { recursive: true });
    for (const shot of shots) {
      const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 1, isMobile: shot.mobile, hasTouch: shot.mobile });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('fitflow-theme', t);
        } catch {
          /* ignore */
        }
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      const page = await context.newPage();
      await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, theme, `${shot.name}.png`), fullPage: shot.fullPage });
      console.log(`✓ ${theme}/${shot.name}.png`);
      await context.close();
    }
  }
}

async function capture(
  page: import('playwright').Page,
  context: import('playwright').BrowserContext,
  clientId: string | undefined,
  setCurrency: (c: 'CAD' | 'USD') => Promise<unknown>,
  original: 'CAD' | 'USD',
) {
  for (const theme of ['light', 'dark'] as const) {
    fs.mkdirSync(path.join(OUT, theme), { recursive: true });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('fitflow-theme', t);
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute('data-theme', t);
    }, theme);

    for (const p of PAGES) {
      const url = p.path === '__first_client__' ? (clientId ? `/clients/${clientId}` : null) : p.path;
      if (!url) continue;
      await setCurrency(p.currency ?? original);
      const isSearch = p.name === 'search';
      await page.goto(`${BASE}${isSearch ? '/' : url}`, { waitUntil: 'networkidle' });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      if (isSearch) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
        await page.keyboard.type('a');
      }
      // Let skeletons resolve and ring sweeps finish.
      await page.waitForTimeout(p.settle ?? 900);
      const file = path.join(OUT, theme, `${p.name}.png`);
      await page.screenshot({ path: file, fullPage: !isSearch });
      console.log(`✓ ${theme}/${p.name}.png`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
