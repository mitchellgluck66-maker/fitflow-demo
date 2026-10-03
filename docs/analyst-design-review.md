# Analyst design review — 2026-10-03

On approval, step 0 copies this file to `docs/analyst-design-review.md` and adds the standing rule to
CLAUDE.md. One item per commit, `npm run check` green between commits, no push. Nothing runs against a
real database except what Mitchell runs (`smoke:analyst` twice, pasted back).

## Context

FitFlow is a product any company connects its GHL / Meta / Stripe to. The Analyst's Wave 1 fixes were
driven by one tenant's live runs; several close one failure, not the class. This review classifies each
fix, proposes the design that removes the failure class for every tenant, and plans the two redesigns
Mitchell asked for (numbers by reference; fixtures from the demo tenant only), plus the 1-hour prefix
cache and the per-turn cost split. Accepted cost target: **≤ $0.50 USD per Opus chat question**.

Standing rule (→ CLAUDE.md): **Fix the class, design for any tenant; no tenant-specific logic in `lib/`.**

## 1. Every Wave 1 fix, classified

| # | Fix (commit) | Class it closed | Design or patch | If patch: the design that removes the class |
|---|---|---|---|---|
| 1 | Nullable enums → sentinels (`84b5c7e`) | API strict-schema rule | design (API rule, enforced by `strictSchema` guard + contract test) | — |
| 2 | Per-request schema budget in code (`1688594`) | API limits (20 / 24 / 16) | design (`schemaBudget#assertRequestBudget` before every send) | — |
| 3 | Tools non-strict + server Zod; only the answer strict (`e213090`) | "compiled grammar too large" | design (one strict schema per request; bad input = error result) | — |
| 4 | check:schemas cheap, bisecting (`694390b`) | cost of the live check | design | — |
| 5 | Gather in one round; batch `calculate` (`013b2d3`) | 19 rounds / turn | design (contract + tool shape) | — |
| 6 | Moving cache breakpoints (`c2359a9`) | 40 % uncached input | design (API caching rule) | — |
| 7 | **Display strings `<key>Text` beside refs** (`462ca99`) | model re-renders numbers → repair | **patch** — compensates the model's formatting; doubles result size | **A**: the model never writes a number; the server renders refs with one formatter |
| 8 | Verifier matches magnitude (negative deltas) (`462ca99`) | "-50%" unciteable | **patch** to the verifier's rendering table | **A**: no rendering table — the server renders the sign-free magnitude, the model writes "down" |
| 9 | Repairs counted from the turn's own events (`462ca99`) | wrong "repaired once" | design (instrumentation) | — |
| 10 | Starter snapshot (`72e9fd8`, `68bb295`) | 5–11 rounds for "last week" | design (holds for any tenant: data health + last complete week vs previous + 8-week baseline) | — |
| 11 | Trimmed results; calibrated estimate (`739a3b5`) | estimates 35–60 % low | design (calibration from the tenant's own completed runs) | — |
| 12 | note_proposals persisted (`ca7d412`) | memory never reached a later turn | design | — |
| 13 | Smoke: 1 turn, `--max-usd`, targets line (`4f3045a`, `168e5c1`, `2a6bbbb`) | cost of testing | design | — |
| 14 | Record / replay with wire hash (`e9d606b`) | $0 regression | design | **B** for what it records against |
| 15 | **Units: `unitForPath` regexes + declared `unit`** (`c97d459`) | "$4,937.50" vs 493750 flagged | half patch — the name regexes (`rate|roas|share|…`, `count|enrollments|…`) guess | **A1**: a unit is a *contract* of the tool result (suffix `Cents`, declared `unit`, or an explicit count list) — the sweep test fails on any guess |
| 16 | Chat effort "medium" (`71eff12`) | 17.4K output tokens at "high" | design (policy per thread kind; any tenant) | — |
| 17 | **Scrubber over the real contacts table** (`3c18bbf`) | real names in a fixture | **patch** — rewrites customer data after reading it; a bare first name that is an ordinary word is left | **B**: fixtures are never recorded against a real database |
| 18 | Repair turn on verification failure (`run.ts`, Wave 1) | wrong / unsourced numbers | design — but today it fires on *formatting* (class 7/8/15), ~1 extra round, +$0.15–0.25, +20–40 s | **A** leaves it for unknown refs and raw digits only |

Not in scope of the review (unchanged, design): the loop (append-only log, stop/continue, orphan sweep),
caps, the brief, the glossary, freshness, the ledger-from-log rule, the partial-data `coverage` blocks.

## 2. Redesign A — numbers by reference

**What.** The model never writes a numeric value for a metric. Prose carries **ref tokens**; the server
renders every number from the ledger with ONE formatter, so what the owner reads equals the engine's
value by construction.

- Token: `{<ref>}` with the ref exactly as the tool result gives it — `{r2:data.marketing.paidCacCents}`,
  `{r7:data.results[0].value}` (a calculate row). Optional reading hint for a ratio: `{ref|%}` (share) or
  `{ref|x}` (multiple); without a hint the ledger's declared reading is used (`pct` → %, `ratio` /
  `multiple` → ×, a delta's `pct` → %). Optional `{ref|k}` for compact money ("$3.7k CAD").
- Formatter `lib/analyst/render.ts#renderRef(entry, hint)` — the single place that knows units: cents →
  `$1,604.95 CAD` (whole dollars stay whole; currency from the entry; never a sign — the model says
  "down"), `pct` → `41.2 %` → "41%" when whole / one decimal otherwise, multiple → "2.1×", count →
  "1,234", number → up to 2 decimals, hours → "41.6 h". Replaces `display.ts` (deleted).
- Answer schema v2 (`schema.ts`): `sections[].numbers` and `headline.ref` and `actions[].expected_impact_ref`
  are REMOVED (the text carries the refs); `findings[].evidence_refs` stays. Fewer output tokens, no
  duplication, one strict schema still (budget unchanged: 0/24 optional, 0/16 unions).
- Contract (`ANALYST_CONTRACT`, frozen text → one deploy): "Never write a digit for a metric. Write the
  ref in braces and the server prints the number: `Paid CAC fell to {r2:data.marketing.paidCacCents}
  (down {r7:data.results[1].value|%})`. Digits are allowed only in dates, times, durations, ordinals,
  list numbers, and a number the owner wrote in THIS question." The `…Text` siblings are removed from
  tool results (−25–30 % result tokens); `unit` declarations stay.
- Verifier v2 (`verify.ts`): (1) every token resolves (unknown ref → "no such ref"; null → "withheld";
  older than the newest sync marker → "re-fetch"); (2) no raw digit run outside a token except the
  exempt contexts already in `isExemptContext` (ISO dates, times, month-day, years, durations, ordinals,
  markdown list numbers, refs) plus a digit string that appears verbatim in the current question;
  (3) `evidence_refs` / `check_date` as today. ONE repair with the exact problems; after that an
  unresolved token renders as `[no source]` and a raw digit run is wrapped `[unverified: 8]` — shown
  marked, never silently.
- Render at the end of the loop: `renderAnswer(answer, ledger)` → `rendered` (headline, sections, actions,
  findings with every token replaced) stored in `display.answer.rendered` beside the token form; events
  carry `rendered`; the smoke prints the rendered headline; Wave 2's panel renders `rendered`.
- `calculate`: unchanged shape (unit + currency on every row); its `valueText` fields go (the formatter
  renders rows too).

**Why it removes the class.** Classes 7, 8, 15-as-regex and the formatting-driven part of 18 exist
because two renderers (model, verifier) must agree. With one renderer there is nothing to agree on:
rounding, currency code, thousands separators, % vs × are decided once, server-side, from the engine's
value. The model's job shrinks to choosing the right ref — which the ledger can check exactly.

**Cost / latency.** Per turn, from the recorded run (3 rounds, $0.65, 1 repair, 17.4K out at "high"):
- output: `numbers[]` duplicated every number (~150–300 tokens/turn) and the repair answer (~5–8K
  tokens at $20/MTok ≈ $0.10–0.16) go; expected −$0.12–0.20 and −20–40 s on a turn that repaired;
- input: no `…Text` siblings → tool results ~25 % smaller (−1–2K tokens/round, mostly cached after the
  first read);
- with effort "medium" (already landed) the expectation is $0.25–0.40 for a 3-round chat turn — inside
  the $0.50 target, with headroom for a 4th round. The smoke prints the measured split (item D).

**Works.** Smoke turn 1: `repairs 0 · flagged 0`; the rendered headline reads "…8 enrollments…" with the
8 from `{r2:data.kpis.enrollments.current}`; a replayed fixture renders identically.
**Fails.** A token whose ref the ledger does not hold → repair text "no such ref r9:data.x — cite a
number from a tool result in this conversation"; still unresolved → `[no source]` in the rendered text
and `flagged` names it. A digit run in prose outside an exempt context → repair; still there →
`[unverified: 8]`. An owner-stated number is allowed only when it appears verbatim in the question.
**Verify.** `tests/analyst-verify.test.ts` rewritten: token resolution, every exempt context, the
question-verbatim rule, the marked fallbacks; `tests/analyst-render.test.ts`: one formatter per unit,
hints, hours, calculate rows, sign-free; `tests/analyst-run.test.ts`: the repair path on an unknown ref;
`analyst-wire` / `analyst-schema-check` on schema v2 (budget 0/0/0); replay harness on the token form.
Live: `npm run check:schemas`, then `npm run smoke:analyst` twice — target `repairs 0 · flagged 0`,
≤ $0.50, 5 sections.

## 3. Redesign B — fixtures never contain customer data

**What.** `smoke:analyst -- --record` runs ONLY against the seeded demo tenant: a fresh embedded PGlite
in memory, migrations, `seedDemo()` (deterministic: `makeRandom(SEED)`), the brief rebuilt from it, the
real API key. Recording against a database with any non-demo row is refused. The scrubber is deleted.

- `scripts/smoke-analyst.ts --record` spawns itself as a child process with `PGLITE_DATA_DIR=memory`,
  `DATABASE_URL=""`, `FITFLOW_ANALYST_RECORD=1` and the API key resolved by the parent from its
  configured source (settings or env) handed over as `ANTHROPIC_API_KEY` in the child's environment
  (never printed, never written). The child: migrate → `seedDemo()` → `rebuildBrief()` → the smoke with
  `record` → the fixture. Its `database` field is the constant `demo tenant (embedded PGlite, seeded)`.
- Refusal, in the child, before any request: `DATABASE_URL` set, or `select count(*) from contacts
  where origin <> 'demo'` > 0 → "FAIL record · recording runs only against the demo tenant" exit 1.
- `lib/analyst/scrub.ts`, `scrubPeople.ts` → deleted; `replay#scrubFixture` → gone; the fixture's
  `scrub` block → replaced by `tenant: 'demo'`.
- Guard (stays, cheaper): `tests/analyst-replay.test.ts` — every fixture must say `tenant: 'demo'`, and
  every person-shaped string in its tool results (keys `name`, `contactName`, `customerName`, `people[].name`,
  `missing[]`) must be a name the demo seed generates (the seed's name lists are exported from
  `db/seed-demo.ts`); any other name fails "a fixture holds a name that is not from the demo tenant".
  `npm run check:fixtures` keeps `findLeaks` against the real contacts table (one read-only SELECT;
  counts only) as the belt-and-braces check before a push; `findLeaks` moves to `lib/analyst/fixtureGuard.ts`.
- The `--full` conversation records on the demo tenant too (the memory turn's cap is fictional there).

**Why it removes the class.** No customer data is ever read into a fixture, so nothing can leak —
instead of reading it and trying to delete it afterwards (the ordinary-word first name was already a
documented hole). Holds for any tenant because the demo tenant is the same synthetic company everywhere.

**Works.** `fixture written: tests/fixtures/analyst-replay/turn-1.json (demo tenant)`; `npm run check`
replays it; `check:fixtures` → PASS. **Fails.** Any non-demo row in the recording database → the FAIL
line and exit 1, nothing written; a fixture with a non-demo name → the suite fails with the key path.
**Verify.** `tests/analyst-replay.test.ts` (tenant marker, name guard with a planted real-looking name,
refusal logic as a pure function `recordTenantCheck(rows)`); live: `npm run smoke:analyst -- --record`.

## 4. Item C — 1-hour TTL on the stable prefix

`cache_control: { type: 'ephemeral', ttl: '1h' }` on the two system blocks (the tools sit before system
in the cache order, so the prefix = tools + contract + brief); the two moving message breakpoints stay at
5 minutes (a longer TTL must come first — allowed in this order; the reverse is a 400). Same in the
compaction and count requests. `assertRequestBudget` / wire test pin the shape.

Economics (Opus 5.5, ~35K prefix): 1-hour write 2× = $0.28 vs 5-minute 1.25× = $0.175; a read $0.007.
The 1-hour entry pays off whenever the next request on the same prefix lands 5–60 minutes after the
previous one — an owner's second question later in the hour, the dispatch brief check, the two smoke
runs — and the brief is shared by every thread of the tenant for the day. Inside one turn (rounds seconds
apart) both TTLs hit. The estimate (`cost.ts`) prices the prefix write at the 1-hour rate (conservative);
`usageTotals` already splits 5m / 1h writes. Fable: keep 5 minutes (its reads are 0.025×; the
reference recommends a keep-alive over the 2× write) — `ttl` is chosen per model in `buildTurnRequest`.

**Works.** Smoke run 2 (within the hour) shows round 1 `cache …%` > 0 and the new line
`prefix: hit (35.7K read)`; run 1 shows `prefix: written (1h)`. **Fails.** A prefix below the model's
minimum cacheable size, or a brief rebuilt between runs → `prefix: written` again, printed, never
silent. **Verify.** `analyst-wire` (ttl on system only, 1h before 5m, per-model), live: two smoke runs.

## 5. Item D — the cost split per turn

Per turn (and per round in the fixture): input $ · cache read $ · cache write $ · thinking $ · answer $,
from `usage` and `ANALYST_PRICES`. Output is split by measuring the final answer and tool-call blocks
(`count_tokens` is free; one call per turn) and taking the rest of `output_tokens` as thinking — the
split is exact for the answer, derived for thinking, and labelled so. Stored on the turn
(`usage.split`) and printed by the smoke:
`$0.31 = in $0.02 · cache read $0.05 · cache write $0.08 · thinking $0.09 · answer $0.07`.
**Works / Fails.** The five parts sum to the turn's cost (test); a failed count → "answer: ≈ (count
unavailable)" with chars/3.5, never a blank. **Verify.** `tests/analyst-cost.test.ts` (split sums,
fallback), smoke lines.

## 6. Units as a contract (A1, folded into item 1 of the implementation)

The ledger's unit comes from, in order: the `Cents` suffix (money), a declared `unit` on the object for
the generic value keys, the field-name catalog `lib/analyst/units.ts` (an explicit list: `rate`,
`roas`, `ltvToCac`, `pct`, `share`, `conversionFromPrevious`, `coverage` → ratio; `count`,
`enrollments`, … → count; `hours` → hours). No regex guessing: a numeric field whose name is not in the
catalog and has no declared unit is `unknown`, and the sweep test (`tests/analyst-display` → moves to
`tests/analyst-units.test.ts`) fails on it, naming the tool and path. Every tool result builder is the
owner of its units. **Works.** The sweep passes with 0 unknown. **Fails.** A new numeric field with no
unit fails `npm run check` with its path. **Verify.** the sweep over all 15 tools on the demo DB.

## 6b. Approved additions (Mitchell, 2026-10-03)

**E. Direction check** (corrected 2026-10-03: sign words vs judgment words). In every sentence
(headline, sections, actions, findings) that contains a token whose ledger entry is a *delta* (a `pct` /
`abs` of a comparison, a `percent_change` / `difference` calculate row, a trend change), two checks:
- **Sign words** describe the number's sign: `fell / down / decreased / dropped / lower / shrank /
  declined` need a negative value; `rose / up / increased / grew / higher / climbed` a positive one.
- **Judgment words** describe the metric's polarity from the glossary (`lowerIsBetter`): `improved /
  better / stronger / healthier` vs `worsened / worse / weaker / deteriorated`. "Paid CAC improved" with
  a negative delta is correct; with a positive delta it is the mismatch; "Enrollments improved" needs a
  positive delta. The delta's metric is the ledger entry's metric key (comparison rows and trend entries
  name it; a calculate row inherits the metric of its operands when both share one, else judgment words
  are not checked for it and the repair text says why).
- A mismatch → the one repair ("direction: 'fell' next to {r7:…} which is +12%" / "'improved' next to
  Paid CAC {…} which is +12% — Paid CAC is lower-is-better"); still wrong → the rendered sentence is
  wrapped `[check direction] …`, never silent, and `flagged` names it. Neutral wording ("changed by",
  "moved", "is") never flags; a sentence citing two deltas is checked per token with the nearest
  direction word. Tests: sign words both directions, judgment words for a cost metric (Paid CAC) and a
  volume metric (enrollments) in both directions, neutral wording, the nearest-word rule, the marked
  fallback. (`lib/analyst/direction.ts`, pure; the ledger entry carries `delta: true` and `metric`.)

**F. The demo tenant carries every known data-quality class** so replays exercise real failures.
`db/seed-demo.ts` gains, deterministically: manual entries into late stages (class C), a form applicant
routed to an unfollowed pipeline (class X), new clients with no deal value (partial-data rule on
LTV:CAC), consult attendance coverage below 90 % in one week (show rate withheld), CAD + USD payments
(FX at read time), a refund (partial and full), a failed-payment retry on one invoice later paid (one
`initial` after `excluded` failures), and a maturing week (a contact whose history predates
`history_complete_since`). `tests/seed-demo-classes.test.ts` asserts each class is present by querying
the seeded database through the engine (`computeAppliedCaveat`, `ltvCoverage.partial`,
`showRates[].withheld`, `money.unsupportedRows === 0` with both currencies present, `excludedReasonOf`,
`maturity.active` for that week) — never by counting rows. The seed stays `origin='demo'` everywhere and
keeps the same `SEED` story otherwise.

**G. The smoke prints the full rendered answer** — headline, every section's rendered markdown, actions,
findings, note proposals — followed by the cost split (item D), so the answer is reviewed for quality on
every run. Long sections are printed whole (no truncation); the per-turn metrics line stays last.

## 7. Implementation order (Step 2, after approval) — one commit each

0. `docs/analyst-design-review.md` (this file) + CLAUDE.md rule + the `≤ $0.50` target in `SMOKE_TARGETS`.
1. A1 units contract: `lib/analyst/units.ts` catalog, `ledger.ts` uses it, `tests/analyst-units.test.ts`
   sweep; `display.ts` → `render.ts#renderRef` (formatter), `…Text` siblings removed from tool results.
2. A2 schema v2 + contract + verifier v2 + `renderAnswer` + `rendered` in events/log; tests; replay
   harness updated (fixtures stale — none committed).
3. E direction check (`direction.ts`, delta flag on ledger entries, repair text, `[check direction]`).
4. G smoke prints the full rendered answer (every section, actions, findings, proposals).
5. C 1-hour TTL (`api.ts`, `cost.ts` estimate, wire test, smoke `prefix:` line).
6. D cost split (`cost.ts#splitUsage`, `run.ts` measures, smoke line after the answer, test).
7. F demo tenant data-quality classes (`db/seed-demo.ts`, `tests/seed-demo-classes.test.ts`).
8. B record on the demo tenant (child process, refusal, scrubber deleted, guard rewritten,
   `check:fixtures` kept on `fixtureGuard.ts`), README/CLAUDE.md updated.
9. Memory + CLAUDE.md "Analyst — design review 2026-10-03" paragraph.

Then Mitchell runs `npm run check:schemas`, `npm run smoke:analyst` twice, pastes both; then
`smoke:analyst -- --record`.

## 8. What is NOT changed

The loop, caps, brief, glossary, starter snapshot, batch calculate, moving breakpoints, effort policy,
replay harness mechanics, `check:schemas`. No metric definition changes. Nothing in `docs/deferred.md`.
