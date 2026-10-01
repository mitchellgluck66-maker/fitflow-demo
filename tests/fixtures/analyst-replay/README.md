# Analyst replay fixtures

`npm run smoke:analyst -- --record` (one turn → `turn-1.json`) or `-- --full --record` (`conversation.json`)
writes a live run here: every API response, tool result and log row, plus the wire hash of the code
that recorded it. `npm run check` replays each fixture through the real loop at $0
(tests/analyst-replay.test.ts) and fails with "fixtures stale: re-record" when the contract, the tool
definitions, the answer schema or the request shape have changed since.

Tool results carry the names in the database the smoke ran against; the fixture's `database` field says
whether that was demo or REAL data — review before committing a real one.
