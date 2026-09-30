/**
 * Reconcile the mirror against live GoHighLevel now (read-only on GHL): per followed stage × status + pipeline
 * totals, targeted re-fetch of anything that differs, then the verdict.
 *   npm run reconcile:ghl
 * Prints one line per check that differs (or none), then OK / MISMATCH / SKIPPED. Exit 1 unless ok.
 */
import { runMigrations } from '../db/migrate';
import { runReconcile } from '../lib/ghl/reconcile';

async function main() {
  await runMigrations();
  const r = await runReconcile({ trigger: 'cli' });
  if (r.skipped) {
    console.log(`SKIPPED · ${r.skipped}`);
    process.exit(1);
  }
  if (!r.summary) {
    console.log(`FAILED · ${r.error ?? 'no summary'}`);
    process.exit(1);
  }
  const s = r.summary;
  for (const m of s.mismatches) console.log(`MISMATCH ${m.pipelineName} › ${m.stageName}${m.status ? ` · ${m.status}` : ''}: GHL ${m.live} vs mirror ${m.mirror}`);
  for (const k of s.skipped) console.log(`SKIPPED  ${k}`);
  console.log(`\n${s.ok ? 'OK' : 'NOT OK'} · ${s.checks} checks · ${s.stagesChecked} stages × ${s.statuses.join('/')} + totals · re-fetched ${s.refetchedStages} stage(s) · skipped ${s.skipped.length} · ${s.requests} requests`);
  process.exit(s.ok ? 0 : 1);
}
main().catch((e) => {
  console.error(`FAILED · ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
