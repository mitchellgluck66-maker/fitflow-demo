/**
 * Live proof of the FitFlow Analyst against the REAL Anthropic API with the
 * stored key (Definition of done §3; plan items 1 and 8).
 *
 *   npm run smoke:analyst -- --probe   every API assumption on the PRODUCTION wiring, both models (~$1 USD)
 *   npm run smoke:analyst              ONE question on the in-memory store (the cheap check; target ≤ $0.50 USD)
 *   npm run smoke:analyst -- --full    the whole 5-turn conversation (follow-up, budget, memory check, explain) — before a release
 *   --max-usd 1.50                     the hard budget for the run (default 1.00): nothing is sent past it; a stop is a FAIL
 *   --record                           keep the run as a replay fixture (tests/fixtures/analyst-replay/; `npm run check` replays it at $0);
 *                                      names / emails / phones are replaced with Client A, B… BEFORE the file is written
 *
 * Uses the database .env.local points at (for the stored key, the brief and the
 * tools' data). Needs CREDENTIALS_KEY there to decrypt a stored key. Exit 0 only
 * when every line is PASS; SKIP (nothing exercised) exits 1.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { getAnalystConfig } from '../lib/analyst/config';
import { formatProbeLine, runAnalystProbe } from '../lib/analyst/probe';
import { formatUsd } from '../lib/analyst/cost';
import { formatSmokeTurn, parseMaxUsd, runAnalystSmoke, SMOKE_TARGETS, SMOKE_TURNS } from '../lib/analyst/smoke';

async function main() {
  const args = process.argv.slice(2);
  await runMigrations();
  const target = DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite';
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
  // The fixture is committed: it names the kind of database, never the host.
  const record = args.includes('--record') ? { name: full ? 'conversation' : 'turn-1', database: DATABASE_URL ? 'postgres (DATABASE_URL)' : 'embedded PGlite' } : null;
  const { lines, ok, answerMode, model, turns, spentUsd, budgetStopped, runMisses, fixturePath, recordError, effort } = await runAnalystSmoke({ log: (l) => console.log(l), full, maxUsd, record });
  for (const l of lines) console.log(formatSmokeTurn(l));
  const pass = lines.filter((l) => l.status === 'PASS').length;
  console.log(`answer mode · ${model} · effort ${effort ?? '—'} · ${answerMode === 'format' ? 'output_config.format' : 'submit_answer tool (fallback)'}`);
  console.log(`targets (Opus): p50 ≤ ${SMOKE_TARGETS.p50Seconds}s · ≤ ${formatUsd(SMOKE_TARGETS.maxUsd)} per turn · cache ≥ ${SMOKE_TARGETS.cacheSharePctFromRound2}% from round 2 · repairs < ${Math.round(SMOKE_TARGETS.repairRateMax * 100)}% · 0 flagged · estimate within ±${Math.round(SMOKE_TARGETS.estimateTolerance * 100)}% · ${runMisses.length ? `run-level MISSED: ${runMisses.join('; ')}` : model.startsWith('claude-opus') ? 'run-level met' : 'not judged for this model'}`);
  console.log(ok ? `\nALL PASS (${pass}/${turns})` : `\nNOT ALL PASS (${pass}/${turns} passed)${budgetStopped ? ' · budget stop' : ''}${runMisses.length ? ' · targets missed' : ''}`);
  if (record) console.log(fixturePath ? `fixture written (scrubbed): ${fixturePath}` : `FAIL record · no fixture written (${recordError ?? 'no completed turn'})`);
  console.log(`TOTAL ${formatUsd(spentUsd)} of ${formatUsd(maxUsd)} budget`);
  if (record && !fixturePath) process.exit(1);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
