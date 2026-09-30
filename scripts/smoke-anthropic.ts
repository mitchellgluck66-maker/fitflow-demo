/**
 * Live smoke test of the AI features against the REAL Anthropic API with the
 * stored key (Definition of done §3).
 *   npm run smoke:anthropic
 *
 * Uses the database .env.local points at. On production it WRITES one `ask`
 * and one `insight` row to ai_reports (acceptance evidence); the narrative is
 * a dry run and is never stored; remap writes nothing. Costs a few cents.
 * Exit 0 only when every feature PASSes; SKIP (nothing exercised) exits 1.
 */
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { runAnthropicSmoke, formatSmokeLine } from '../lib/anthropic/smoke';

async function main() {
  await runMigrations();
  const target = DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite';
  console.log(`smoke:anthropic · database: ${target} · writes: 1 ask + 1 insight row; narrative is a dry run`);
  const { lines, ok } = await runAnthropicSmoke();
  for (const l of lines) console.log(formatSmokeLine(l));
  const pass = lines.filter((l) => l.status === 'PASS').length;
  console.log(ok ? `\nALL PASS (${pass}/${lines.length})` : `\nNOT ALL PASS (${pass}/${lines.length} passed)`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL smoke · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
