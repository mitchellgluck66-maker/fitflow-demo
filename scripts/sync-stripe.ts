/**
 * Stripe reconcile / backfill from the CLI.
 *   npm run sync:stripe                       (full 7-day reconcile)
 *   npm run sync:stripe -- --delta            (incremental, since the last delta)
 *   npm run sync:stripe -- --backfill [--since 2026-06-01]
 */
import { runMigrations } from '../db/migrate';
import { runStripeSync } from '../lib/stripe/ingest';

async function main() {
  const backfill = process.argv.includes('--backfill');
  const delta = process.argv.includes('--delta');
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  await runMigrations();
  const result = await runStripeSync({ mode: backfill ? 'backfill' : delta ? 'delta' : 'reconcile', trigger: 'cli', since });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
