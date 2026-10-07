/**
 * Live proof of the FitFlow Analyst against the REAL Anthropic API with the
 * stored key (Definition of done §3; plan items 1 and 8).
 *
 *   npm run smoke:analyst -- --probe   every API assumption on the PRODUCTION wiring, both models (~$1 USD)
 *   npm run smoke:analyst              ONE question on the in-memory store (the cheap check; target ≤ $0.50 USD)
 *   npm run smoke:analyst -- --full    the whole 5-turn conversation (follow-up, budget, memory check, explain) — before a release
 *   --max-usd 1.50                     the hard budget for the run (default 1.00): nothing is sent past it; a stop is a FAIL
 *   --record                           keep the run as a replay fixture (tests/fixtures/analyst-replay/; `npm run check` replays it at $0).
 *                                      Runs ONLY on the demo tenant: a child process on an in-memory embedded database,
 *                                      migrated + seeded here, with the configured key — customer data never enters a fixture
 *
 * Uses the database .env.local points at (for the stored key, the brief and the
 * tools' data). Needs CREDENTIALS_KEY there to decrypt a stored key. Exit 0 only
 * when every line is PASS; SKIP (nothing exercised) exits 1.
 */
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { runMigrations } from '../db/migrate';
import { DATABASE_URL, db, contacts } from '../db';
import { seedDemo } from '../db/seed-demo';
import { rebuildBrief } from '../lib/analyst/briefService';
import { recordTenantCheck } from '../lib/analyst/fixtureGuard';
import { getAnalystConfig } from '../lib/analyst/config';
import { formatProbeLine, runAnalystProbe } from '../lib/analyst/probe';
import { formatUsd } from '../lib/analyst/cost';
import { formatSmokeTurn, parseMaxUsd, runAnalystSmoke, SMOKE_TARGETS, SMOKE_TURNS } from '../lib/analyst/smoke';

/** `--record` runs in a CHILD process on the demo tenant: an embedded database in memory, migrated and seeded here. */
const RECORD_CHILD = 'FITFLOW_ANALYST_RECORD_CHILD';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--record') && !process.env[RECORD_CHILD]) return recordInChild(args);
  await runMigrations();
  const recording = Boolean(process.env[RECORD_CHILD]);
  if (recording) {
    // Refuse anything but the demo tenant, then build it: seed + brief. The key arrives from the parent's environment.
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(contacts).where(sql`${contacts.origin} <> 'demo'`);
    const check = recordTenantCheck({ databaseUrl: DATABASE_URL, nonDemoContacts: Number(n) });
    if (!check.ok) {
      console.log(`FAIL record · ${check.reason}`);
      process.exit(1);
    }
    await seedDemo({ log: (l) => console.log(`   seed · ${l.trim()}`) });
    try {
      const brief = await rebuildBrief({ trigger: 'manual', countTokens: false });
      console.log(`   brief · built for the demo tenant (${brief.weeks} weeks, data through ${brief.dataThrough})`);
    } catch (err) {
      console.log(`FAIL record · the demo brief did not build: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const target = recording ? 'demo tenant (embedded PGlite, seeded)' : DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite';
  const config = await getAnalystConfig();
  if (!config.configured) {
    const hint = process.env.CREDENTIALS_KEY ? '' : ' (a stored key needs CREDENTIALS_KEY in .env.local to decrypt)';
    console.log(`SKIP · no Anthropic API key${hint} · database: ${target}`);
    process.exit(1);
  }

  if (args.includes('--probe')) {
    console.log(`smoke:analyst --probe · database: ${target} (key + brief + tools read; writes nothing) · models: ${config.modelDefault}, ${config.modelDeep} · answer mode ${config.answerMode}`);
    const { lines, ok, answerMode } = await runAnalystProbe({ key: config.key, models: [config.modelDefault, ...(config.modelDeep !== config.modelDefault ? [config.modelDeep] : [])], answerMode: config.answerMode });
    for (const l of lines) console.log(formatProbeLine(l));
    const usd = lines.reduce((a, l) => a + l.usd, 0);
    const pass = lines.filter((l) => l.status === 'PASS').length;
    for (const [model, mode] of Object.entries(answerMode)) {
      console.log(`answer mode · ${model} · ${mode === 'format' ? 'output_config.format works with tools + streaming' : mode === 'submit_answer' ? 'output_config.format FAILED — the strict submit_answer fallback works' : 'NEITHER answer mode produced a valid answer'}`);
    }
    console.log(ok ? `\nALL PASS (${pass}/${lines.length}) · ${formatUsd(usd)}` : `\nNOT ALL PASS (${pass}/${lines.length} passed) · ${formatUsd(usd)}`);
    process.exit(ok ? 0 : 1);
  }

  const full = args.includes('--full');
  const maxUsd = parseMaxUsd(args);
  console.log(`smoke:analyst${full ? ' --full' : ''} · database: ${target} (read; the conversation runs on the in-memory store, nothing written) · model ${config.modelDefault} · answer mode ${config.answerMode} · ${full ? `${SMOKE_TURNS.length} turns` : '1 turn (--full for the whole conversation)'} · budget ${formatUsd(maxUsd)}`);
  const record = recording ? { name: full ? 'conversation' : 'turn-1', database: target } : null;
  const { lines, ok, answerMode, model, turns, spentUsd, budgetStopped, runMisses, fixturePath, recordError, effort } = await runAnalystSmoke({ log: (l) => console.log(l), full, maxUsd, record });
  for (const l of lines) console.log(formatSmokeTurn(l));
  const pass = lines.filter((l) => l.status === 'PASS').length;
  console.log(`answer mode · ${model} · effort ${effort ?? '—'} · ${answerMode === 'format' ? 'output_config.format' : 'submit_answer tool (fallback)'}`);
  console.log(`targets (Opus): first verified section ≤ ${SMOKE_TARGETS.firstSectionSeconds}s · p50 ≤ ${SMOKE_TARGETS.p50Seconds.review}s review / ${SMOKE_TARGETS.p50Seconds.metric}s metric · ≤ ${formatUsd(SMOKE_TARGETS.maxUsd.cold)} per cold turn / ${formatUsd(SMOKE_TARGETS.maxUsd.warm)} warm · cache ≥ ${SMOKE_TARGETS.cacheSharePctFromRound2}% from round 2 · repairs < ${Math.round(SMOKE_TARGETS.repairRateMax * 100)}% · 0 flagged · estimate within ±${Math.round(SMOKE_TARGETS.estimateTolerance * 100)}% · ${runMisses.length ? `run-level MISSED: ${runMisses.join('; ')}` : model.startsWith('claude-opus') ? 'run-level met' : 'not judged for this model'}`);
  console.log(ok ? `\nALL PASS (${pass}/${turns})` : `\nNOT ALL PASS (${pass}/${turns} passed)${budgetStopped ? ' · budget stop' : ''}${runMisses.length ? ' · targets missed' : ''}`);
  if (record) console.log(fixturePath ? `fixture written (demo tenant): ${fixturePath}` : `FAIL record · no fixture written (${recordError ?? 'no completed turn'})`);
  console.log(`TOTAL ${formatUsd(spentUsd)} of ${formatUsd(maxUsd)} budget`);
  if (record && !fixturePath) process.exit(1);
  process.exit(ok ? 0 : 1);
}

/**
 * The parent: resolve the API key from the configured source (the stored, encrypted setting or the environment),
 * then run this script again as a child on an in-memory embedded database with the key in its environment —
 * never printed, never written. The child's exit code is ours.
 */
async function recordInChild(args: string[]): Promise<void> {
  await runMigrations();
  const config = await getAnalystConfig();
  if (!config.configured || !config.key) {
    console.log(`SKIP · no Anthropic API key${process.env.CREDENTIALS_KEY ? '' : ' (a stored key needs CREDENTIALS_KEY in .env.local to decrypt)'} — nothing recorded`);
    process.exit(1);
  }
  console.log('smoke:analyst --record · recording runs on the demo tenant: an embedded database in memory, seeded by this run (customer data never enters a fixture)');
  const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    stdio: 'inherit',
    env: { ...process.env, [RECORD_CHILD]: '1', PGLITE_DATA_DIR: 'memory', DATABASE_URL: '', ANTHROPIC_API_KEY: config.key },
  });
  process.exit(child.status ?? 1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
