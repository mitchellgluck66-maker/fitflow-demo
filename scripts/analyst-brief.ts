/**
 * Build (or rebuild) the Analyst's business brief from the engine, against the
 * database .env.local points at. `npm run analyst:brief`. The dispatch does
 * this once a day; this is the manual version for a first deploy or a smoke.
 */
import { runMigrations } from '../db/migrate';
import { rebuildBrief } from '../lib/analyst/briefService';

runMigrations()
  .then(() => rebuildBrief({ trigger: 'manual' }))
  .then((r) => {
    console.log(`OK ${r.reason}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`FAIL brief · ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
