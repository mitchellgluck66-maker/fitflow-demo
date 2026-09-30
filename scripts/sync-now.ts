/**
 * Run one GHL delta sync from the CLI (same code path as the hourly cron).
 *   npm run sync:now
 *   npm run sync:now -- --since 2026-08-01T00:00:00Z   (appointment window lower bound)
 *   npm run sync:now -- --full                          (re-fetch every followed contact)
 * Ingestion v2: always reads the whole followed pipeline, then the weekly mirror pass if due.
 */
import { runMigrations } from '../db/migrate';
import { runGhlSync } from '../lib/ghl/ingest';

async function main() {
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  await runMigrations();
  const result = await runGhlSync({ mode: 'delta', trigger: 'cli', since, full: process.argv.includes('--full') });
  console.log(JSON.stringify({ ...result, cursor: result.cursor ? `mirror pass ${result.cursor.index + 1}/${result.cursor.order.length}` : null }, null, 2));
  console.log(`\n${result.ok ? (result.partial ? 'PARTIAL' : 'OK') : 'FAILED'} · ${result.skipped ?? result.progress ?? result.error}`);
  process.exit(result.ok ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
