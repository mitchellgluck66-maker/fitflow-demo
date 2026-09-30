/**
 * Live proof of the Applied reconciliation (Definition of done §3): the Meta campaign-level
 * submits for the last 7 account days through the real call path, and the ledger's last complete
 * week from the database .env.local points at. Read-only (no rows written).
 *   npm run smoke:reconcile
 * Exit 0 only when every line is PASS; SKIP exits 1.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { getMetaConfig } from '../lib/meta/config';
import { readMetaAccount } from '../lib/meta/ingest';
import { fetchCampaignSubmits } from '../lib/meta/client';
import { readAppliedSummary } from '../lib/reconcile/appliedLedger';
import { readRatioSummary } from '../lib/reconcile/appliedRatio';
import { shift } from '../lib/reconcile/ratioDrift';
import { todayInTimezone } from '../lib/day';
import { CANDIDATE_LABEL } from '../lib/reconcile/definitions';

async function main() {
  await runMigrations();
  const target = DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite';
  console.log(`smoke:reconcile · database: ${target} · read-only`);
  let ok = true;

  const ledger = await readAppliedSummary();
  if (!ledger) {
    console.log('FAIL ledger · never ran — the dispatch step applied_ledger has not completed (or run Setup → Reconciliation → Reconcile now)');
    ok = false;
  } else {
    const w = ledger.lastWeek;
    const classes = (Object.keys(w.byClass) as Array<keyof typeof w.byClass>).filter((k) => w.byClass[k].count > 0).map((k) => `${k} ${w.byClass[k].count}${w.byClass[k].unverified ? ` (${w.byClass[k].unverified} contact date unverified)` : ''}`).join(' · ');
    console.log(`PASS ledger · ${w.label} · ${w.current} counted (current) · ${w.candidate} ${CANDIDATE_LABEL} · ${classes} · unresolved ${w.unresolved} · sample excluded ${ledger.sampleExcluded} · mirror as of ${ledger.mirrorAsOf ?? 'never'} · computed ${ledger.ranAt}`);
  }

  const meta = await getMetaConfig();
  const account = await readMetaAccount();
  if (!meta.configured) {
    console.log('SKIP meta submits · Meta not connected — nothing exercised');
    process.exit(1);
  }
  if (!account?.timezone) {
    console.log('FAIL meta submits · Meta account timezone unknown (the Meta sync records it)');
    process.exit(1);
  }
  const until = todayInTimezone(account.timezone);
  const since = shift(until, -6);
  const r = await fetchCampaignSubmits({ since, until });
  if (r.error) {
    console.log(`FAIL meta submits · ${r.error}`);
    ok = false;
  } else {
    const byCampaign = new Map<string, number>();
    for (const row of r.rows) byCampaign.set(row.campaignName, (byCampaign.get(row.campaignName) ?? 0) + row.submits);
    console.log(`PASS meta submits · ${since} – ${until} (${account.timezone}) · ${r.requests} GET · ${[...byCampaign].map(([n, v]) => `${n} ${v}`).join(' · ') || 'no rows'}${r.rejected ? ` · ${r.rejected} rejected rows` : ''}`);
  }
  const ratio = await readRatioSummary();
  if (!ratio) console.log('FAIL ratio · never ran — the dispatch step applied_ratio has not completed'), (ok = false);
  else console.log(`PASS ratio · through ${ratio.through} (${ratio.metaDayTz}) · ${ratio.campaigns.map((c) => `${c.campaignName}: ${c.state}${c.rolling7 !== null ? ` ${c.rolling7.toFixed(2)}×` : ''} (Meta ${c.meta7} / FitFlow ${c.fitflow7})`).join(' · ')} · ${ratio.unmatchedUtmRows} counted rows match no campaign${ratio.errors.length ? ` · errors: ${ratio.errors.join('; ')}` : ''}`);
  console.log(ok ? '\nALL PASS' : '\nNOT ALL PASS');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
