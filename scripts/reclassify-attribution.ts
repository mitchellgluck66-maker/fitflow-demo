/**
 * One-shot paid/organic backfill for contacts imported before Phase G.
 * Idempotent; manual overrides are never touched.
 *   npm run reclassify:attribution
 */
import { runMigrations } from '../db/migrate';
import { runAttributionClassification } from '../lib/attribution/run';

async function main() {
  await runMigrations();
  const r = await runAttributionClassification();
  console.log(`✓ Attribution reclassified: ${r.scanned} contacts · ${r.paid} paid · ${r.organic} organic · ${r.manual} manual overrides kept · ${r.updated} rows updated`);
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
