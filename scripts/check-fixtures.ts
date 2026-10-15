/**
 * `npm run check:fixtures` — the fixture guard against the database .env.local points at (read-only: one
 * SELECT of names / emails / phones). `npm run check` runs the same guard against the test database; this
 * runs it against the REAL contacts table, which is the one that matters before a push.
 *
 *   PASS turn-1 · demo tenant · no name / email / phone of 1,204 people found
 *
 * A real contact who shares a name the demo seed can produce is not a leak (the fixture is recorded on the demo
 * tenant only, and `nonDemoNames` proves every name in it is a demo name); emails and phones are always checked.
 *   FAIL turn-1 · 3 names, 1 email from the contacts table — re-record (npm run smoke:analyst -- --record)
 *
 * Exit 0 only when every fixture passes. Values are never printed, only counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../db/migrate';
import { DATABASE_URL } from '../db';
import { readFixtures, REPLAY_DIR, NOT_DEMO_MESSAGE } from '../lib/analyst/replay';
import { describeLeaks, findLeaks, nonDemoNames, type Person } from '../lib/analyst/fixtureGuard';
import { db, contacts, payments } from '../db';
import { DEMO_PEOPLE } from '../db/seed-demo';

/** The people a fixture must not contain: every contact and every Stripe customer name / email on a payment. Read-only. */
async function loadPeople(): Promise<Person[]> {
  const [cs, ps] = await Promise.all([
    db.select({ firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone }).from(contacts),
    db.select({ name: payments.customerName, email: payments.email }).from(payments),
  ]);
  const out: Person[] = cs.map((c) => ({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', email: c.email, phone: c.phone }));
  for (const p of ps) {
    const name = (p.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name && !p.email) continue;
    const [first, ...rest] = name.split(' ');
    out.push({ firstName: first ?? '', lastName: rest.join(' '), email: p.email, phone: null });
  }
  return out;
}

async function main() {
  await runMigrations();
  const people = await loadPeople();
  const fixtures = readFixtures();
  console.log(`check:fixtures · database: ${DATABASE_URL ? 'postgres (DATABASE_URL)' : 'embedded PGlite'} · ${people.length.toLocaleString('en-US')} people · ${fixtures.length} fixture(s)`);
  if (fixtures.length === 0) console.log('SKIP · no fixture recorded (npm run smoke:analyst -- --record)');
  let ok = true;
  const demoNames = new Set([...DEMO_PEOPLE.allNames()].map((n) => n.toLowerCase()));
  for (const { name, fixture } of fixtures) {
    const leaks = findLeaks(fs.readFileSync(path.join(REPLAY_DIR, `${name}.json`), 'utf8'), people, demoNames);
    const strangers = nonDemoNames(fixture);
    if (fixture.tenant !== 'demo') {
      ok = false;
      console.log(`FAIL ${name} · ${NOT_DEMO_MESSAGE}`);
    } else if (strangers.length) {
      ok = false;
      console.log(`FAIL ${name} · ${strangers.length} name(s) the demo tenant cannot produce (first at ${strangers[0].path})`);
    } else if (leaks.length) {
      ok = false;
      console.log(`FAIL ${name} · ${describeLeaks(leaks)} from the contacts table — re-record (npm run smoke:analyst -- --record)`);
    } else console.log(`PASS ${name} · demo tenant · no name / email / phone of ${people.length.toLocaleString('en-US')} people found`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL check:fixtures · ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
