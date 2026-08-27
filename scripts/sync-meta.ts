/**
 * Meta Ads insights sync from the CLI.
 *   npx tsx scripts/sync-meta.ts               # delta (last 3 days)
 *   npx tsx scripts/sync-meta.ts --backfill    # from settings.backfill_from
 *   npx tsx scripts/sync-meta.ts --since 2026-07-01
 */
import { runMigrations } from '../db/migrate';
import { runMetaSync } from '../lib/meta/ingest';

async function main() {
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  const mode = process.argv.includes('--backfill') || since ? 'backfill' : 'delta';
  await runMigrations();
  const result = await runMetaSync({ mode, trigger: 'cli', since });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
