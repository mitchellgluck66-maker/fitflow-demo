/**
 * One-shot incident cleanup: resolve unmapped-stage noise from unfollowed /
 * mapped / archived stages, stale silence notices and duplicate errors.
 * Idempotent.   npm run incidents:sweep
 */
import { runMigrations } from '../db/migrate';
import { sweepIncidentNoise } from '../lib/incidents/noise';

async function main() {
  await runMigrations();
  const r = await sweepIncidentNoise();
  console.log(`✓ Incident sweep: ${r.unmappedResolved} unmapped-stage · ${r.silenceResolved} stale silence · ${r.duplicateErrorsResolved} duplicate errors resolved (${r.total} total) — ${r.openAfter} open incidents remain`);
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
