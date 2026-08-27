/**
 * Remove every demo row (origin='demo' + demo-marked AI reports, digests and
 * sync runs). Real data is never touched.   npm run db:wipe:demo
 */
import { runMigrations } from '../db/migrate';
import { clearDemoData, getDataProvenance } from '../lib/provenance';

async function main() {
  await runMigrations();
  const removed = await clearDemoData();
  console.log('✓ Demo rows removed:', removed);
  const prov = await getDataProvenance();
  console.log(`  sample-data banner will ${prov.hasDemoData ? 'STILL SHOW (unexpected)' : 'no longer show'}; real contacts: ${prov.ghlContacts}`);
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
