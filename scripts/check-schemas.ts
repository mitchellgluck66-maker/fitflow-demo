/**
 * `npm run check:schemas` — run before any push and after every schema change (2026-09-30). It MEASURES
 * with real messages.create calls on the exact production prompt, per model: the static budget
 * (lib/anthropic/schemaBudget.ts), count_tokens (secondary), the answer schema alone, the production
 * request (answer strict + 15 non-strict tools), and — informationally — how many tools could be strict
 * alongside the answer (binary search). `--quick` skips the capacity search. Each line PASS/FAIL with the
 * API's exact message and cost. Needs the stored key (CREDENTIALS_KEY in .env.local) and a built brief
 * (`npm run analyst:brief`); without them it SKIPs and exits 1.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { getAnalystConfig } from '../lib/analyst/config';
import { currentBrief } from '../lib/analyst/briefService';
import { checkAnalystSchemasLive, formatSchemaLine, productionRequestForBudget } from '../lib/analyst/schemaCheck';
import { auditRequestBudget } from '../lib/anthropic/schemaBudget';
import { formatUsd } from '../lib/analyst/cost';

async function main() {
  await runMigrations();
  const target = DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite';
  const config = await getAnalystConfig();
  if (!config.key) {
    console.log(`SKIP check:schemas · no Anthropic API key${process.env.CREDENTIALS_KEY ? '' : ' (a stored key needs CREDENTIALS_KEY in .env.local)'} · database: ${target}`);
    process.exit(1);
  }
  const brief = await currentBrief();
  if (!brief) {
    console.log(`SKIP check:schemas · the business brief hasn't been built yet — run \`npm run analyst:brief\` first · database: ${target}`);
    process.exit(1);
  }
  console.log(`check:schemas · database: ${target} · brief ${brief.hash.slice(0, 8)} (${brief.dataThrough}) · models ${config.modelDefault}, ${config.modelDeep}`);
  const budget = auditRequestBudget(productionRequestForBudget(config.answerMode));
  console.log(`${budget.ok ? 'PASS' : 'FAIL'} static budget · ${budget.message}`);
  const lines = budget.ok ? await checkAnalystSchemasLive({ key: config.key, brief: brief.text, models: [config.modelDefault, ...(config.modelDeep !== config.modelDefault ? [config.modelDeep] : [])], answerMode: config.answerMode, scope: process.argv.includes('--quick') ? 'probe' : 'full' }) : [];
  for (const l of lines) console.log(formatSchemaLine(l));
  const ok = budget.ok && lines.every((l) => l.ok);
  const usd = lines.reduce((a, l) => a + l.costUsd, 0);
  console.log(ok ? `\nALL PASS · ${formatUsd(usd)}` : '\nNOT ALL PASS — fix the schema before pushing');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL check:schemas · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
