/**
 * `npm run check:fixtures` — the fixture guard against the database .env.local points at (read-only: one
 * SELECT of names / emails / phones). `npm run check` runs the same guard against the test database; this
 * runs it against the REAL contacts table, which is the one that matters before a push.
 *
 *   PASS turn-1 · scrubbed (7 people → Client A…) · no name / email / phone of 1,204 people found
 *   FAIL turn-1 · 3 names, 1 email from the contacts table — re-record (npm run smoke:analyst -- --record)
 *
 * Exit 0 only when every fixture passes. Values are never printed, only counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { readFixtures, REPLAY_DIR, UNSCRUBBED_MESSAGE } from '../lib/analyst/replay';
import { describeLeaks, findLeaks } from '../lib/analyst/scrub';
import { loadPeople } from '../lib/analyst/scrubPeople';

async function main() {
  await runMigrations();
  const people = await loadPeople();
  const fixtures = readFixtures();
  console.log(`check:fixtures · database: ${DATABASE_URL ? 'postgres (DATABASE_URL)' : 'embedded PGlite'} · ${people.length.toLocaleString('en-US')} people · ${fixtures.length} fixture(s)`);
  if (fixtures.length === 0) console.log('SKIP · no fixture recorded (npm run smoke:analyst -- --record)');
  let ok = true;
  for (const { name, fixture } of fixtures) {
    const leaks = findLeaks(fs.readFileSync(path.join(REPLAY_DIR, `${name}.json`), 'utf8'), people);
    if (!fixture.scrub) {
      ok = false;
      console.log(`FAIL ${name} · ${UNSCRUBBED_MESSAGE}`);
    } else if (leaks.length) {
      ok = false;
      console.log(`FAIL ${name} · ${describeLeaks(leaks)} from the contacts table — re-record (npm run smoke:analyst -- --record)`);
    } else console.log(`PASS ${name} · scrubbed (${fixture.scrub.people} people → Client A…) · no name / email / phone of ${people.length.toLocaleString('en-US')} people found`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL check:fixtures · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
