/**
 * Live proof of the FitFlow Analyst against the REAL Anthropic API with the
 * stored key (Definition of done §3; plan items 1 and 8).
 *
 *   npm run smoke:analyst -- --probe   every API assumption, both models (~$0.30 USD)
 *   npm run smoke:analyst              one question + a 3-turn follow-up, in-memory store
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
    console.log(`smoke:analyst --probe · database: ${target} (key only; writes nothing) · models: ${config.modelDefault}, ${config.modelDeep}`);
    const { lines, ok, answerMode } = await runAnalystProbe({ key: config.key, models: [config.modelDefault, ...(config.modelDeep !== config.modelDefault ? [config.modelDeep] : [])] });
    for (const l of lines) console.log(formatProbeLine(l));
    const usd = lines.reduce((a, l) => a + l.usd, 0);
    const pass = lines.filter((l) => l.status === 'PASS').length;
    for (const [model, mode] of Object.entries(answerMode)) {
      console.log(`answer mode · ${model} · ${mode === 'format' ? 'output_config.format works with tools + streaming' : mode === 'submit_answer' ? 'output_config.format FAILED — the strict submit_answer fallback works' : 'NEITHER answer mode produced a valid answer'}`);
    }
    console.log(ok ? `\nALL PASS (${pass}/${lines.length}) · ${formatUsd(usd)}` : `\nNOT ALL PASS (${pass}/${lines.length} passed) · ${formatUsd(usd)}`);
    process.exit(ok ? 0 : 1);
  }

  // The conversation smoke lands with plan item 8 (Setup card + smoke); until then this is not verification.
  console.log(`FAIL smoke · the conversation smoke is not built yet (plan item 8) — run with --probe for the API assumptions`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
