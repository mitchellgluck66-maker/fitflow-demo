/**
 * Playwright screenshot harness — walks every tab in both themes.
 *
 *   npm run screenshots            # against http://localhost:3000 (start `next dev` first)
 *   BASE_URL=http://localhost:3111 npm run screenshots
 *
 * Output: docs/screens/{light,dark}/{page}.png (full page, 1440px wide).
 * Theme is forced by stamping data-theme on <html> before each capture, the
 * same attribute ThemeProvider uses, so the shots reflect real token values.
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = path.join(process.cwd(), 'docs', 'screens');

const PAGES: Array<{ name: string; path: string; settle?: number }> = [
  { name: 'command-center', path: '/?range=last_30_days&compare=previous_period' },
  { name: 'scorecard', path: '/scorecard?range=last_week&compare=previous_period' },
  { name: 'funnel', path: '/funnel?range=last_30_days&compare=previous_period' },
  { name: 'ads', path: '/ads?range=last_30_days&compare=previous_period' },
  { name: 'revenue', path: '/revenue?range=last_30_days&compare=previous_period' },
  { name: 'clients', path: '/clients' },
  { name: 'client-profile', path: '__first_client__' },
  { name: 'reports', path: '/reports' },
  { name: 'setup', path: '/setup' },
  { name: 'search', path: '/?open_search=1' },
];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  // Resolve the first client id for the profile shot.
  const res = await page.request.get(`${BASE}/api/clients?limit=1`);
  const first = (await res.json()) as { rows?: Array<{ id: string }> };
  const clientId = first.rows?.[0]?.id;

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

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
