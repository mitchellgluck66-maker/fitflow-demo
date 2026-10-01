# Analyst replay fixtures

`npm run smoke:analyst -- --record` (one turn → `turn-1.json`) or `-- --full --record` (`conversation.json`)
writes a live run here: every API response, tool result and log row, plus the wire hash of the code
that recorded it. `npm run check` replays each fixture through the real loop at $0
(tests/analyst-replay.test.ts) and fails with "fixtures stale: re-record" when the contract, the tool
definitions, the answer schema or the request shape have changed since.

**A fixture never holds real people.** Before the file is written, every name, email and phone is
replaced with a stable placeholder (Client A, B… — `lib/analyst/scrub.ts`), the result is checked
against everyone in the contacts table and the payments' customer names, and it must still replay;
otherwise nothing is written. A fixture without its `scrub` block fails the suite ("fixture not
scrubbed: re-record"). `npm run check:fixtures` runs the same guard against the real database before a
push. `*.local` files in this folder are ignored by git.
