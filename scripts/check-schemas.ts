/**
 * `npm run check:schemas` — the free live schema check before any push (2026-09-30). Sends the EXACT
 * production Analyst prompt (contract + current brief + all 15 tools + the answer schema as a strict
 * tool) to messages.countTokens on both models: the API validates every schema and charges nothing.
 * PASS/FAIL per model with the exact API message. Needs the stored key (CREDENTIALS_KEY in .env.local)
 * and a built brief (`npm run analyst:brief`); without them it SKIPs and exits 1 — not verified.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { getAnalystConfig } from '../lib/analyst/config';
import { currentBrief } from '../lib/analyst/briefService';
import { checkAnalystSchemasLive, formatSchemaLine } from '../lib/analyst/schemaCheck';

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
  const lines = await checkAnalystSchemasLive({ key: config.key, brief: brief.text, models: [config.modelDefault, ...(config.modelDeep !== config.modelDefault ? [config.modelDeep] : [])] });
  for (const l of lines) console.log(formatSchemaLine(l));
  const ok = lines.every((l) => l.ok);
  console.log(ok ? '\nALL PASS' : '\nNOT ALL PASS — fix the schema before pushing');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL check:schemas · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
