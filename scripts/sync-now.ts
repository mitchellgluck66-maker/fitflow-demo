/**
 * Run one GHL delta sync from the CLI (same code path as the hourly cron).
 *   npm run sync:now
 *   npm run sync:now -- --since 2026-08-01T00:00:00Z
 */
import { runMigrations } from '../db/migrate';
import { runGhlSync } from '../lib/ghl/ingest';

async function main() {
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  await runMigrations();
  const result = await runGhlSync({ mode: 'delta', trigger: 'cli', since });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
