/**
 * Live proof of the FitFlow Analyst against the REAL Anthropic API with the
 * stored key (Definition of done §3; plan items 1 and 8).
 *
 *   npm run smoke:analyst -- --probe   every API assumption on the PRODUCTION wiring, both models (~$1 USD)
 *   npm run smoke:analyst              one question + a 3-turn follow-up, in-memory store (~$1 USD)
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
import { formatSmokeTurn, runAnalystSmoke, SMOKE_TURNS } from '../lib/analyst/smoke';

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

  console.log(`smoke:analyst · database: ${target} (read; the conversation runs on the in-memory store, nothing written) · model ${config.modelDefault} · answer mode ${config.answerMode}`);
  const { lines, ok, answerMode, model } = await runAnalystSmoke({ log: (l) => console.log(l) });
  for (const l of lines) console.log(formatSmokeTurn(l));
  const usd = lines.reduce((a, l) => a + Number((/\$([\d.]+) USD$/.exec(l.cost) ?? [])[1] ?? 0), 0);
  const pass = lines.filter((l) => l.status === 'PASS').length;
  console.log(`answer mode · ${model} · ${answerMode === 'format' ? 'output_config.format' : 'submit_answer tool (fallback)'}`);
  console.log(ok ? `\nALL PASS (${pass}/${SMOKE_TURNS.length}) · ${formatUsd(usd)}` : `\nNOT ALL PASS (${pass}/${SMOKE_TURNS.length} passed) · ${formatUsd(usd)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
