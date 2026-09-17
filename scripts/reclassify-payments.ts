/**
 * One-shot payment_class backfill for rows imported before Phase G.
 * Idempotent — re-run any time; only rows whose class changes are written.
 *   npm run reclassify:payments
 */
import { runMigrations } from '../db/migrate';
import { runPaymentClassification } from '../lib/stripe/classify';

async function main() {
  await runMigrations();
  const r = await runPaymentClassification();
  console.log(
    `✓ Payments reclassified: ${r.scanned} scanned · ${r.initial} initial · ${r.recurring} recurring · ${r.unclassed} not cash (failed / refunded / plan rows) · ${r.updated} rows updated`,
  );
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
