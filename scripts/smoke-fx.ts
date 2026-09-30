/**
 * Live smoke test of the Bank of Canada feed against the stored rates (Definition of done §3).
 *   npm run smoke:fx
 * Reads BoC's latest USD→CAD observation (GET, no credentials) and the rate FitFlow stores for that date, and
 * prints PASS when they are equal (or when a manual rate deliberately overrides that date), FAIL otherwise.
 * Also prints today's footer line. Read-only: it does not run the feed.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL, db, fxRates } from '../db';
import { and, eq } from 'drizzle-orm';
import { fetchBocRates } from '../lib/fx/boc';
import { loadMoneyContext } from '../lib/money/store';
import { fxNote } from '../lib/money';
import { getTimezone } from '../lib/settings';
import { todayInTimezone } from '../lib/day';

async function main() {
  await runMigrations();
  console.log(`smoke:fx · database: ${DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite'} · read-only`);
  const live = await fetchBocRates({ recent: 1 });
  if (live.error || live.rates.length === 0) {
    console.log(`FAIL boc · ${live.error ?? 'no observation returned'}`);
    process.exit(1);
  }
  const { date, rate } = live.rates[0];
  const [stored] = await db.select().from(fxRates).where(and(eq(fxRates.date, date), eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD')));
  let ok = false;
  if (!stored) console.log(`FAIL stored · Bank of Canada ${date} = ${rate}; FitFlow has no USD→CAD row for ${date} (the fx dispatch step fills it)`);
  else if (stored.source === 'manual') {
    ok = true;
    console.log(`PASS stored · ${date}: a MANUAL rate ${stored.rate} overrides Bank of Canada ${rate} (by design)`);
  } else if (Math.abs(stored.rate - rate) < 1e-9) {
    ok = true;
    console.log(`PASS stored · ${date}: FitFlow ${stored.rate} (${stored.source}) = Bank of Canada ${rate}`);
  } else console.log(`FAIL stored · ${date}: FitFlow ${stored.rate} (${stored.source}) ≠ Bank of Canada ${rate}`);
  const ctx = await loadMoneyContext();
  const note = fxNote(ctx, todayInTimezone(await getTimezone()));
  console.log(`footer · ${note.text}`);
  if (note.source === 'seed') {
    ok = false;
    console.log('FAIL footer · today still converts at the seed PLACEHOLDER');
  }
  console.log(ok ? '\nALL PASS' : '\nNOT ALL PASS');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(`FAIL smoke · ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
