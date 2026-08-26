/**
 * Backfill everything from June 16, 2026 (settings.backfill_from) forward.
 * Every row it writes is flagged backfilled=true. Idempotent.
 *   npm run backfill
 *   npm run backfill -- --since 2026-06-16
 */
import { runMigrations } from '../db/migrate';
import { runGhlSync } from '../lib/ghl/ingest';

async function main() {
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  await runMigrations();
  const result = await runGhlSync({ mode: 'backfill', trigger: 'cli', since });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
