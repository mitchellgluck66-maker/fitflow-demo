# Analyst replay fixtures

`npm run smoke:analyst -- --record` (one turn → `turn-1.json`) or `-- --full --record` (`conversation.json`)
writes a live run here: every API response, tool result and log row, plus the wire hash of the code
that recorded it. `npm run check` replays each fixture through the real loop at $0
(tests/analyst-replay.test.ts) and fails with "fixtures stale: re-record" when the contract, the tool
definitions, the answer schema or the request shape have changed since.

**A fixture never holds customer data — by construction.** `--record` runs ONLY on the demo tenant: a
child process on an in-memory embedded database that the run migrates and seeds (`db/seed-demo.ts`),
with the configured API key handed over in its environment. Recording against a database with a URL or
any non-demo row is refused. Two guards keep it true: every person-shaped string in a fixture must be a
name the demo seed can produce (`lib/analyst/fixtureGuard.ts`, in `npm run check`), and
`npm run check:fixtures` searches every fixture for the real contacts table's names, emails and phones
before a push. `*.local` files in this folder are ignored by git.
