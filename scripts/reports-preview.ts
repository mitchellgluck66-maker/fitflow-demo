/**
 * Companion stage 3 — build a report for a period WITHOUT sending: prints the numbers and writes the email HTML.
 *
 *   npm run reports:preview -- --report daily   --date 2026-10-20     # the day itself
 *   npm run reports:preview -- --report weekly  --date 2026-10-21     # the Sun–Sat week containing the date
 *   npm run reports:preview -- --report monthly --date 2026-09-15     # that month
 *   (no --date: the period the next scheduled run would send; --out <dir> to write elsewhere than docs/screens)
 *
 * Output: docs/screens/report-<kind>-<period start>.html (+ .txt). Uses the database .env.local points at — a run
 * against the real tenant carries real client names and notes, so send its output to a scratch folder (--out).
 */
import fs from 'fs';
import path from 'path';
import { buildReport } from '../lib/reports/build';
import { decideReport } from '../lib/reports/run';
import { periodContaining } from '../lib/reports/period';
import { reportKindOf } from '../lib/reports/kinds';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const kind = reportKindOf(arg('report') ?? 'daily');
  if (!kind) throw new Error('--report must be daily, weekly or monthly');
  const date = arg('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const now = new Date();
  const period = date ? periodContaining(kind, date) : (await decideReport(kind, now)).period;
  const built = await buildReport(kind, period, { now });
  const m = built.model;
  const dir = arg('out') ?? path.join(process.cwd(), 'docs', 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `report-${kind}-${period.start}`);
  fs.writeFileSync(`${base}.html`, built.html);
  fs.writeFileSync(`${base}.txt`, built.text);
  console.log(`${m.subject}`);
  console.log(`period ${m.period.start} → ${m.period.end} · empty: ${m.empty}`);
  console.log(`headline: ${m.headline}`);
  for (const c of m.totals) console.log(`  ${c.label.padEnd(26)} ${c.value.padEnd(14)} ${c.sub ?? ''}`.trimEnd());
  console.log(`needs attention (${m.attention.length}):`);
  for (const a of m.attention) console.log(`  - ${a}`);
  if (m.health) console.log(m.health);
  for (const s of m.sections) {
    if (s.type === 'stats') {
      console.log(`${s.title}${s.hint ? ` · ${s.hint}` : ''}`);
      for (const c of s.cards) console.log(`  ${c.label.padEnd(26)} ${c.value.padEnd(14)} ${c.sub ?? ''}`.trimEnd());
    } else if (s.type === 'table') console.log(`${s.title}: ${s.rows.length} row(s)`);
    else if (s.type === 'lines') console.log(`${s.title}: ${s.lines.length ? s.lines.join(' | ') : 'nothing'}`);
    else console.log(`${s.title ?? 'note'}: ${s.text}`);
  }
  console.log(`wrote ${base}.html and .txt — nothing was sent`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
