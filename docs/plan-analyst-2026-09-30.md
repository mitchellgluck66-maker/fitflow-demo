# Plan: FitFlow Analyst (Parts B, C, D), 2026-09-30

## Order of work after approval

1. This plan lives at `docs/plan-analyst-2026-09-30.md`.
2. **The queued UI-audit fixes come first** (`docs/audit-ui-2026-09-30.md`, P1 items 1–9, then the
   P2 copy items): one commit per fix, `npm run check` green, no push. They aren't part of this
   plan, but they run before it for a reason: items 2, 3, 5, 6 and 7 change numbers the Analyst
   reads (who counts as an applicant, cohort conversions capped at 100%, failed payments per
   invoice, refund matching). The glossary in item 2 below is then written against the corrected
   definitions.
3. Analyst Wave 1, then I stop and report. Waves 2 and 3 each start only after you've run that
   wave's proof commands.

**Approved by Mitchell, 2026-09-30, with the amendments below. They override the items they touch.**

## Approved amendments (Mitchell, 2026-09-30)

1. **No orphaned turns** (item 5). A turn whose lease expires without progress (a killed function,
   no client to call `continue`) is marked `failed` within 5 minutes, with the reason.
   - **Change:** every progress event refreshes a heartbeat on the turn. A sweep marks a `running`
     turn with a heartbeat older than 5 minutes as failed ("the function stopped mid-round and
     nothing resumed it"). The sweep runs on every thread read, every thread list, every new turn,
     and in the hourly dispatch, so it doesn't depend on anyone having the panel open.
   - **Works:** the thread shows "Analyst request failed: <reason> · Retry"; Retry resumes from
     the last completed round.
   - **Fails:** each orphaned turn opens or refreshes one `analyst_turn_failed` incident, counted
     in Setup → Incidents. Nothing ever shows "answering" indefinitely.
   - **Verify:** a test that kills mid-round with no `continue` and asserts the failed state, the
     reason and the incident within the window; a test that a healthy long turn (heartbeats
     arriving) is never swept.
2. **Maturing data in the brief and in tool results** (items 3, 4, 12). Weeks before
   `history_complete_since` (2026-09-01) are marked maturing for the history-dependent metrics,
   by the same rule as the maturing badge (`lib/metrics/maturity.ts`).
   - **Change:** each weekly row in the brief and each tool result carries `maturing: true` for
     those metrics and weeks. Every baseline states whether it excludes or includes maturing weeks,
     with the week count. The contract forbids calling a change against a maturing week real. The
     server backs that up: an answer that compares a history-dependent metric with a maturing
     period must carry the caveat, or it goes to repair.
   - **Works:** "why did consults jump vs August?" answers that August's stage history is
     incomplete, so the jump isn't a real change.
   - **Fails:** the missing caveat triggers the repair turn, then a visible flag.
   - **Verify:** brief and tool tests for the flag on both sides of Sep 1 and after the sunset
     date; the behaviour suite gains the "consults vs August" case, which must cite the caveat.
3. **The eval depends on the harness** (item 12). `scripts/verify.ts` must report 0 FAIL (only
   PASS / PENDING / INFO) before the numbers suite counts.
   - **Change:** `eval:analyst` runs the harness first and refuses the numbers suite on any FAIL,
     printing which check failed.
   - **Verify:** the harness output is included in the Wave 2 report next to the eval output.
4. **Owner profile gaps are visible** (items 3, 8, 13). When gross margin, the monthly target,
   offer prices or contract values are empty, Setup → Analyst shows a checklist: "Withheld until
   filled: CAC payback, pace to target, funnel-leak $".
   - **Change:** the same gap list goes into the brief and into `get_notes`. The withheld metric
     returns null with the missing field's name.
   - **Works / Fails:** the Analyst names the missing field instead of estimating; an estimate in
     its place fails verification, because there is no ref to cite.
   - **Verify:** tests per gap; a behaviour case asking for CAC payback with no margin set.
5. **Approved: the weekly-review cron line in `vercel.json`** (item 17). Email stays out of scope.
6. **Every AI cost figure is labelled USD** (items 7, 8, 9, and the smoke and eval output): "$0.21
   USD", in the panel, Setup, the confirmation prompt and the scripts.

**The Wave 1 report must include** the probe output, and state whether the answer uses
`output_config.format` or the `submit_answer` fallback.

## Context

Wave 2 made the numbers trustworthy. The Analyst puts a CMO + CFO on top of them: the owner asks in
plain language and gets what happened, why, the $ impact, what to do, and how we'll know. It must
never disagree with the dashboard, never advise on stale data, and never show a number it can't
trace to a tool result.

Spec: `docs/claude-code-prompt-ai-analyst.md` (B, C, D). Design: `docs/fitflow-analyst-demo.html`,
matched exactly in dark mode. Part A is shipped. The Definition of done (CLAUDE.md) applies to every
item: each one below states **Works / Fails / Verify**.

### Decisions already made (Mitchell, 2026-09-30)
- **One shared history.** No identity: everyone with the password sees the same threads and
  reports. `created_by` stays in the schema, nullable and unused; the "author" filter is dropped.
- **The panel follows the app theme.** Dark = the demo exactly; light = same layout, orb and motion
  with the light tokens.
- Default model `claude-opus-5-5`; deep analysis `claude-fable-5-1`. `askClaude` and its
  `MODEL_OPTIONS` stay untouched for the existing small features.

### Defaults I chose; say so at approval if you want them changed
- **Client data sent to Anthropic: names and stage only.** No emails or phone numbers in any tool
  result. "Who to call today" lists names with their FitFlow links.
- **Server-side model fallback is off in v1.** A refusal is shown plainly with Retry and recorded
  as a warning incident. The docs suggest opting in; for business analytics a refusal is unlikely,
  and the fallback adds a second model and another beta to every request.
- **Cost caps:** $3 per run and $150 per month before a confirmation is required, both editable.
- **The Ask card stays as it is.** Retiring it in favour of the Analyst is a later decision.

### What exists today (from exploration)
- `lib/anthropic/client.ts#askClaude`: official SDK (`@anthropic-ai/sdk` ^0.121; latest is 0.129),
  single turn, forced strict tool, no streaming, no cost computation. Reusable: `describeError`,
  `scrub`, `isTransientError`, `incident.ts#noteAnthropicOutcome`, `strictSchema.ts`
  (`toStrictToolSchema`, `findUnsupportedKeywords`), `lib/syncLock.ts#acquireLock`.
- Read functions the pages use: `lib/metrics/service.ts` (`getScorecard`, `getMetricTrend`,
  `getTodoBuckets`), `lib/queries/clients.ts` (`listClients`, `getClientProfile`),
  `lib/sync/markers.ts`, `lib/sync/ghlFreshness.ts`. Payments and per-source freshness are built
  inline in their API routes: no shared module yet.
- Number verifier: `lib/metrics/ask.ts#verifyAnswerNumbers` passes a number if **any** context
  value is within 1%, and every integer 0–31 is free. Against a large set of tool results that
  would pass almost anything, so it can't be reused as is.
- No glossary in code. Definitions live in the header comment of `lib/metrics/index.ts`, and that
  comment is stale ("applied = contact created"; F14 changed it).
- No route streams. No markdown renderer. No serif font. No `flynn-orb.js`: the engine exists only
  inline in the demo HTML. `app/layout.tsx` mounts only NavBar + banner + the page.
- Dispatch steps get 60 s and the dispatch stops starting steps at 110 s, so a model run can't
  live inside it.

---

## API facts, verified against the current Anthropic docs (2026-09-30)

Sources: models overview, pricing, compaction (overview, on-demand, threshold), structured outputs,
and the migration notes for Opus 5.5 and Fable 5.1.

| Fact | Consequence for the build |
|---|---|
| `claude-opus-5-5`: $4 / $20 per MTok, cache read $0.20, 5-min cache write $5. `claude-fable-5-1`: $10 / $50, cache read $0.25, write $12.50. Both 1M context at standard price, 128K max output. | `lib/analyst/cost.ts` price table; cost from `usage` incl. cache fields. |
| Thinking is always on, adaptive only. `disabled` or `budget_tokens` return 400. Default effort: Opus `medium`, Fable `high`. | Send `thinking: {type: 'adaptive'}` only; set `effort` explicitly, fixed per thread. |
| Forced `tool_choice` (`any` / `tool`) returns 400 on both. `auto` + `strict: true` tools are fine. | `tool_choice: auto` only. A contract test fails on any forced choice. |
| Thinking blocks must be passed back unchanged. They're bound to the model and to the conversation prefix (`system`, `tools`, every earlier message byte-identical). A changed prefix is a 400 on accounts created on or after 2026-08-31; `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`) degrades instead and reports `input_transformations`. Opus can't read Fable blocks; Fable reads Opus blocks. | History stored verbatim as text, append-only. `drop_block` always set. One model per thread. |
| Text between tool calls returns as progress-update thinking blocks; `thinking.display: "updates"` (beta `thinking-display-updates-2026-08-18`) streams them. | Source of the live status line. |
| Prompt caching: prefix match over tools → system → messages; 512-token minimum; max 4 breakpoints; a model, tools or `output_config.format` change rebuilds the cache. | Frozen tools and system; one output schema for every turn. |
| Compaction on demand (beta `compact-2026-09-04`, `compaction: {type: 'summarize'}`) is the recommended form; the returned block replaces the history and goes first. Both models supported. Not allowed while a tool call is unanswered, nor with `output_config.format`. | Compact after a completed turn past a token limit, as a separate request. |
| Structured outputs (`output_config.format`) are supported on both models and combine with strict tools. Limits: no min/max/length keywords, ≤ 24 optional params, ≤ 16 union-typed params, ≤ 20 strict tools. A refusal or `max_tokens` stop may not match the schema. | One answer schema, everything required; Zod re-validates; both stop reasons handled. |
| `stop_reason: "refusal"` arrives as HTTP 200. | Checked before reading content; shown plainly. |
| Fable 5.1 needs 30-day data retention on the org; a zero-retention org gets a 400. | The probe and Setup → Verify name this cause. |

**Not yet proven live** (documented, but I have not exercised the combination): structured output +
several tool rounds + streaming in one request, with cache reads from round 2; `display: "updates"`
text arriving in our tool loop; whether your org is enforced for preserved thinking; a run
continuing after the browser disconnects on Vercel. Item 1 settles the API ones before anything is
built on them.

---

## Architecture

```
 orb launcher ─▶ AnalystPanel (right, 440px, condenses the page; full-screen ≤ 820px)
   │  page context {page, range, compare, mode, selected tile / campaign / client}
   ▼
 POST /api/analyst/turns ──▶ the turn runs to completion server-side (not tied to the connection)
   │      SSE view: status · section · actions · notice · usage · continue · error · done
   │      GET …/turns/[id]/events?after=n  (reconnect and replay)     POST …/turns/[id]/stop
   ▼
 lib/analyst/run.ts   agent loop (stream → tools → stream), one model per thread
   ├─ system  = contract + glossary │ business brief + owner notes     (2 cache breakpoints)
   ├─ tools   = fixed, name-sorted, strict, READ-ONLY ── call ──▶ lib/metrics/service · lib/queries · markers
   ├─ output  = ONE answer schema: headline, sections[key, body, numbers[text, ref]], actions, findings
   ├─ verify  = every number must carry a ref to a tool result in this thread, and equal it
   ├─ persist = one append-only log (analyst_messages), each round written atomically
   └─ cost    = usage → USD; estimate and cap before spending, re-checked between rounds
 dispatch step `analyst_brief` (daily, engine only, no model call) ──▶ analyst_briefs
 Wave 3: presets ─▶ analyst_reports + analyst_actions ─▶ Reports → "AI reports" ─▶ history analysis, action grading
```

### Rules the runtime enforces (each has a test)
1. **One append-only log.** `analyst_messages.api_json` holds each API message as **text** (jsonb
   would reorder keys and break the byte-identical replay). The request is rebuilt from the log
   from the last compaction row. An assistant message and all its tool results are written in one
   transaction after the tools finish, so the log always ends in a replayable state. Unfinished,
   refused or cut-off assistant turns are never stored.
2. **The prefix is frozen.** Tools are a constant. Page context, preset instructions, current data
   health, the repair message and the explain formula go in the user turn, never in `system`. The
   brief carries no freshness (markers move hourly), so its hash changes only when data or notes
   change. When the brief or a deploy does change the prefix, `drop_block` discards old thinking
   once: expected, and logged with the reason.
3. **A number is shown only with a ref.** Each section lists its numbers as `{text, ref}`. The
   server checks that every number in the prose is one of them and that it equals the referenced
   tool-result value under that unit's rendering (count exact; cents as whole dollars or one-decimal
   k; ratio as a percent). The brief orients the model but isn't citeable. Arithmetic goes through
   a `calculate` tool whose results get their own refs.
4. **Deterministic where it matters.** Formula values, the KPI snapshot, the funnel-leak $ value,
   action grades, recurrence counts, the stale-data notice and section headings are produced by
   code from the engine. The model explains them.
5. **The run isn't the connection.** Locking the phone doesn't cancel a report. Stop is an explicit
   request. One turn per thread at a time (a lease); a second tab gets "This thread is answering".
6. **Nothing half-written.** A report row is inserted only after the run completes and validates.

---

## Wave 1: runtime (no new UI except Setup → Analyst)

Shippable on its own: the Analyst works from the CLI and the smoke; nothing else changes on screen.

### 1. Live probe of every API assumption: `npm run smoke:analyst -- --probe`
- **Change:** upgrade `@anthropic-ai/sdk` to ^0.129 (existing suites must stay green; the two
  fields the SDK doesn't type yet go through one local type, guarded by the wire contract test).
  `lib/analyst/probe.ts` sends small real requests to both models and checks, one line each:
  auto tool choice with a strict tool; schema-valid structured output after three tool rounds,
  streamed; `cache_read_input_tokens > 0` from round 2; `display: "updates"` text present;
  `drop_block` accepted and `input_transformations` empty on an untouched history; on-demand
  compaction returns a block and the next turn accepts it; token counting works.
- **Works:** `PASS <assumption> · <model> · <tokens> · $<cost>` for every line, exit 0.
- **Fails:** `FAIL <assumption> · <model> · Anthropic <status> · <type>: <message>`, exit 1. A
  retention 400 on Fable prints "Fable 5.1 needs 30-day data retention on the Anthropic org". A
  missing key prints SKIP and exits non-zero: SKIP is not verified.
- **Verify:** you run it (about $0.30). **If structured output + tools fails**, the answer moves to
  a strict `submit_answer` tool carrying the same schema, under `tool_choice: auto` with one nudge
  if the model ends without calling it. The choice is made once, here, before any thread exists,
  so the tools list never changes afterwards. I'd report the result before continuing.

### 2. Metric glossary: `lib/metrics/glossary.ts` (the single source of definitions)
- **Change:** one entry per metric the app shows (about 50): key, label, plain definition, how it
  differs from its neighbours, formula in words, maturing flag, and `worked(result)`: the formula
  with this range's engine numbers, such as "$9,890.33 ÷ 6 paid enrollments = $1,648.39 CAD".
  Covers the trend metrics, funnel stages and conversions, show rates, campaign-table columns,
  revenue classes, MRR and time in stage. It exports `METRIC_DEFINITION_VERSION` (`2026-09-30`).
  The stale header comment in `lib/metrics/index.ts` becomes a pointer to it; `ASK_SYSTEM` and the
  insight definitions read from it.
- **Works:** `worked()` for Paid CAC on any range equals the tile to the cent.
- **Fails:** a metric whose inputs are missing returns `value: null` with the reason (rule 8),
  never a computed number.
- **Verify:** a test that, for every key × every preset range on the fixtures, the glossary value
  equals the engine value the page renders; a test that every `TREND_METRICS`, `DISPLAY_METRICS`
  and funnel-stage key has an entry.

### 3. Business brief + owner notes
- **Change:**
  - `lib/analyst/brief.ts#buildBrief()`: assembled from engine calls only. Every KPI weekly since
    the first data; trailing 8- and 12-week baselines; per-campaign weekly history; stage
    conversion over time in both modes; revenue split; seasonality notes computed from the series;
    the glossary; the decisions log (F2, F4, F9, F14, FX, Meta CAD); the owner profile and notes.
  - Table `analyst_briefs` (hash, built_at, text, tokens). Dispatch step `analyst_brief`, once per
    local day after the sources; "Rebuild now" in Setup; rebuilt when notes are saved.
  - Owner profile in settings (`analyst_owner_profile`: goals, offer prices, gross margin, target
    CAC, monthly revenue target, team, a good week) and dated notes in table `analyst_notes`
    (`active` / `proposed` / `rejected`). The Analyst proposes a note through its answer
    (`note_proposals`); it's saved only when the owner approves. No tool writes anything.
- **Works:** Setup → Analyst shows "Brief built 02:10 · 21,340 tokens · data through Sep 29". Every
  number in the brief equals `getScorecard` for that week.
- **Fails:** a build error leaves the previous brief in place, marks the step `failed` with the
  reason, and the panel says "Brief is from <date>". With no brief at all the Analyst refuses to
  start: "The business brief hasn't been built yet · Build now".
- **Verify:** tests: brief numbers = engine for each week on fixtures; a rebuild with unchanged
  data gives the same hash; a proposed note never reaches the prompt until approved.

### 4. Tools: `lib/analyst/tools.ts`
- **Change:** one strict, read-only tool per capability, each a thin wrapper over the function the
  page calls: `get_scorecard`, `get_funnel`, `get_stage_people`, `get_campaigns`, `get_revenue`,
  `get_trend`, `list_clients`, `get_client`, `get_payments`, `get_data_health`, `compare_periods`,
  `get_notes`, `get_metric` (glossary + worked formula), `get_todo`, `calculate`.
  - Every result is `{range, currency, fx, freshness, data}`, size-capped and paginated, and each
    number in it gets a stable ref.
  - `calculate` takes typed operations over refs (difference, percent change, ratio, product, sum,
    per-unit) in integer cents. It refuses to average ratios: "recompute from totals".
  - Two extractions so tool and page share one function: `lib/queries/payments.ts` and
    `lib/sync/sourceFreshness.ts` (their routes switch to them).
  - `list_clients` filters by contact-created date while the funnel dates by application, so its
    result states its date basis and the model is told to use `get_stage_people` for "who applied".
- **Works:** `get_scorecard` for last week returns exactly what `/api/scorecard` returns.
- **Fails:** invalid input or a thrown function returns an error result the model can read and
  correct; it never rejects the round and never returns an empty success.
- **Verify:** a parity test per tool (tool data deep-equals the page function on a seeded
  database); a contract test that every schema passes `findUnsupportedKeywords`, is `strict`, and
  the list is name-sorted and ≤ 20; a test that no tool result contains an email or phone;
  `npm run verify:readonly` still passes.

### 5. Agent loop, streaming and persistence: `lib/analyst/run.ts`
- **Change:**
  - Migration **0017** (RLS on every table): `analyst_threads`, `analyst_turns` (status, progress
    events, stop flag, usage, cost, error), `analyst_messages` (`api_json` text, display jsonb,
    unique `(thread_id, seq)`), `analyst_briefs`, `analyst_notes`.
  - `runAnalystTurn` streams with the SDK, runs a round's tool calls in parallel, appends the
    round, and loops to the final answer. Guards: at most 16 rounds; tools never run after
    `max_tokens` or `refusal`; one retry on a transient error, rebuilt from the log; its own client
    without `askClaude`'s 60 s timeout; `noteAnthropicOutcome` keeps the one open incident.
  - The turn runs under `after()` so it outlives the connection. Progress events are stored on the
    turn; the SSE response and the replay endpoint are views of them. Before each round, past 240 s
    of function time, the turn persists and emits `continue`; the client (or the cron) calls
    `…/continue` and it resumes from the log.
  - A store interface with a database and an in-memory implementation, so smoke and eval run
    against production without writing a row.
  - Compaction: after a completed turn above 300K tokens, one on-demand request with the same
    system and tools and the instruction to keep decisions, entities and open questions but carry
    no figures. A compaction row marks the new start of the API history; the visible transcript is
    never deleted.
  - Status events: a fixed label per tool call ("Reading 12 weeks of campaign data…") plus the
    model's own progress update when present.
- **Works:** a 5-turn conversation resolves "that campaign" and "last week vs this"; turn 2 onward
  shows cache reads; `input_transformations` is empty.
- **Fails:** an `error` event reading `Analyst request failed: <reason>` with `retryable`; the
  thread keeps its last good state. A killed function leaves the turn resumable from the last
  completed round. Stop ends the turn within a second and stores nothing from the unfinished round.
- **Verify:**
  - Wire contract tests for both models: only adaptive thinking; `tool_choice` auto; no sampling
    parameters; every beta header paired with its field, both ways; at most 4 breakpoints;
    `drop_block` set; two builds of the same log are string-equal; the compaction request shares
    `system` and `tools` and carries no output format.
  - Log tests on PGlite: `api_json` round-trips byte-exactly (key order, `1.0`); a crash at each
    step leaves a replayable log; a repeated client turn id doesn't duplicate; a second concurrent
    turn gets 409; a dropped connection doesn't stop the run and Stop does.
  - Refusal, `max_tokens`, transient-retry, continue and compaction tests against a fake SSE stream.

### 6. Answer schema, verifier and release
- **Change:**
  - One `output_config.format` schema for every turn, everything required (empty arrays, no
    nullables): `kind` (answer / explain / report / clarify); `headline {text, ref}`;
    `sections[{key, body_md, numbers[{text, ref}]}]` with `key` an enum of every section the app
    knows; `actions[{action, why, owner, kind, expected_impact_ref, confidence, metric,
    check_date}]`; `findings[{area, metric, finding, direction, severity, evidence_refs}]`;
    `note_proposals`.
  - The server owns the structure: it checks the key sequence against the mode (explain = *What it
    is / What yours says / What to do*; full report = the 8 sections) and renders the headings from
    the keys, so labels can't drift. The executive summary is written last and shown first.
  - `lib/analyst/ledger.ts` derives refs from the stored tool-result rows (so compaction can't
    lose them). `lib/analyst/verify.ts` applies rule 3. Small integers pass without a ref only in
    a date, duration or ordinal context. A ref older than the current sync marker is rejected with
    "re-fetch".
  - Release: the accumulated stream is re-parsed; a section is emitted to the client once it's
    complete and verified. A failed section or structure gets one repair turn (an appended hidden
    message; the failed answer stays in the log). If it still fails, the number is shown flagged
    ("not verified against the dashboard") and counted on the message.
  - Stale data is decided by the server each turn, not by the model: the data-health notice is
    emitted first, and an answer containing a `spend` action is sent back for repair, then has
    that action removed with a stated reason if it persists.
- **Works:** citation chips show verified values; "Every number is checked against your dashboard
  before it's shown" is true by construction.
- **Fails:** flagged numbers are visibly marked and counted; a structure failure reads "The answer
  didn't have the required sections · Retry".
- **Verify:** verifier tests: a coincidental match without a ref is rejected; an uncited "3
  enrollments" is rejected; "Sep 3" passes; per-unit rounding; a stale ref; `calculate` refusing a
  ratio average; a fabricated number caught. Schema within the documented limits. A stale-marker
  test: notice first, spend action repaired then stripped.

### 7. Cost: estimate, cap, actuals
- **Change:** `lib/analyst/cost.ts` prices each request from `usage` (input, output, cache read,
  cache write, compaction iterations) by the model the response names, in USD. Before a run: a
  token count of the prompt plus a per-mode allowance gives an estimate. Over the per-run cap or
  the monthly budget the route returns `needs_confirmation` and nothing is spent. Between rounds,
  spent + projected above the confirmed amount pauses the turn for confirmation. An aborted stream
  is priced from what was received and marked estimated.
- **Works:** each answer ends with "12.4K in · 3.1K out · $0.21". Setup shows month-to-date spend.
- **Fails:** "This run is estimated at $4.10, above your $3 cap · Run anyway / Cancel".
- **Verify:** price-table tests for both models incl. cache tiers and iterations; the confirmation
  and in-loop pause tests; the smoke prints estimate vs actual.

### 8. Setup → Analyst card, and the smoke
- **Change:** an `AccordionCard`: models, caps, owner profile, notes (approve / reject proposals),
  brief status with Rebuild, month-to-date spend, and **Verify**, which runs a real two-round
  streamed tool turn on each selected model: the same path the feature uses. `npm run
  smoke:analyst` runs one question plus a 3-turn follow-up live with the in-memory store.
- **Works:** "Connected · verified with a streamed tool call · claude-opus-5-5".
  Smoke: `PASS turn 1 · 3 tools · 18.2K in (15.9K cached) · 2.4K out · $0.19 · 21 s`.
- **Fails:** "Verification failed: <exact error>". Smoke prints FAIL per turn with the reason.
- **Verify:** card and route tests against the fake stream; the smoke is the live proof.

---

## Wave 2: the panel, conversation, and "What does this mean?" (Part D)

### 9. Orb launcher and panel, matched to the demo
- **Change:**
  - `components/analyst/`: `flynnOrb.ts` (the demo's engine ported as is; purple base
    `[143,102,255]`, bright `[228,216,255]`), `FlynnOrb`, `AnalystProvider` (open, explain, ask
    about), `AnalystLauncher`, `AnalystPanel`, `ThinkingState`, `AnswerView`, `Composer`,
    `ThreadList`.
  - Mounted once in `app/layout.tsx`; hidden on `/login`. The page shell takes `padding-right:
    440px` with the demo's `.62s cubic-bezier(.22,1,.36,1)`; at ≤ 820px the panel is full-screen.
    A new `--z-panel` token sits between popover and overlay, so modals and ⌘K stay above. Toasts
    move clear of the orb.
  - Newsreader is added to the existing font link. Answers render with `react-markdown` +
    `remark-gfm` (two new dependencies; no raw HTML) and a small plugin for the word-fade. The
    formula box, citation chips and actions table are components fed by structured fields.
  - Thinking state: the 40px orb at speed 2.4 with the halo, shimmer "Thinking", and a sub-line
    that fades between live statuses. No typing dots. Send becomes Stop while a turn runs.
  - Threads only behind the Conversations button; New conversation; Esc closes and focus returns
    to the orb. Reduced motion: a static orb and no fades.
- **Works:** beside the demo in dark mode, the launcher, panel, welcome, presets, thinking state,
  answer and composer match. The context pill reads "Viewing Command Center · Aug 1 – 31 · data
  fresh 12 min ago" and turns amber when a source is stale. Locking the phone mid-answer and
  reopening shows the finished answer.
- **Fails:** "Analyst request failed: <reason> · Retry", never a blank or an endless orb. No key:
  the welcome says "Connect Anthropic in Setup". A second tab on a busy thread: "This thread is
  answering".
- **Verify:** Playwright screenshots in both themes at desktop and iPhone width: launcher, welcome,
  thinking, answer, error, thread list, cost confirmation; the dark set compared with the demo
  file rendered at the same size. A reconnect test (drop the stream, replay from the last event).

### 10. Page context
- **Change:** `lib/analyst/pageContext.ts` (pure): pathname + query → `{page, range, compare,
  mode, selected}`. Campaign rows and the client profile pass their id; a tile passes its metric.
  It's composed into the user turn once and stored as sent.
- **Works:** opened from a campaign row, "why is this one worse?" answers about that campaign for
  the range on screen.
- **Fails:** an unknown page sends `page: "unknown"` and the Analyst asks which range.
- **Verify:** unit tests per route incl. anchored weeks, cohort mode and custom ranges; a test
  that the context range equals the range the page requests; one eval case from a campaign row.

### 11. "What does this mean?" on every metric
- **Change:** `ExplainButton` (the demo's hover affordance; always visible on touch; icon-only in
  table and chart headers). Added to `KpiDeltaTile`, `KPITile`, `SortableHeader`, `CardHeader` for
  charts, `Funnel` rows and conversion chips, `FunnelStrip`, the show-rate rings, time-in-stage
  tiles, the Subscriptions tile, and every `CampaignTable`, `SourceBreakdownTable` and
  `PaymentsTable` header. A click opens the panel with the metric and range. The formula box is
  rendered from the glossary's `worked()`, so its numbers are the engine's by construction; the
  model writes the three sections around it.
- **Works:** every metric has the button. Each answer has exactly the three sections; a healthy
  flat metric says "No action needed; flag it if X crosses Y".
- **Fails:** a stale source makes "What to do" open with the data warning and no spend advice; a
  withheld metric (say a show rate under 90% coverage) explains why it's withheld.
- **Verify:** a static test that every glossary key is wired to at least one surface; a Playwright
  check that every key appears as `[data-explain]` on the demo-seeded pages; the explain suite in
  item 12.

### 12. Golden eval: `npm run eval:analyst`
- **Change:** `scripts/eval-analyst.ts`, read-only with the in-memory store, writing
  `docs/eval-analyst-<date>.md` (PASS/FAIL, tokens and cost per case). Suites:
  - **numbers** (25 questions): expected values come from the independent SQL in
    `scripts/verify.sql`, run against the same database for last week, last month, month to date
    and Jul 16 → today; the suite re-runs if a sync marker moved in between. A question passes when
    the tool-result value behind the answer's `headline.ref` equals the SQL value (counts and cents
    exact, ratios within 0.0005) and the verifier flagged nothing. Threshold ≥ 24/25.
  - **explain** (10 metrics × 2 ranges): the three sections, formula values equal to the engine,
    nothing flagged.
  - **behaviour**, on a seeded fixture database with the live model: flat metric → no action;
    stale source → warning first and no spend action; ambiguous question → one clarifying
    question; the 5-turn context conversation; the campaign-row case.
- **Works:** `numbers 25/25 · explain 20/20 · behaviour 5/5 · $6.40`, exit 0.
- **Fails:** each failing case prints the question, expected, got and any flagged numbers; exit 1.
  A case that fails once and passes on re-run is reported as flaky, not passed silently.
- **Verify:** you run it against production (about $5–10 per full run on Opus). A unit test covers
  the scorer.

---

## Wave 3: reports, storage, history (Part C)

### 13. Engine helpers the reports need (pure, in `lib/metrics/`, fixture-tested, in the glossary)
These are new numbers, so their formulas are stated here for your approval. No existing definition
changes.
- **Funnel leak:** per step, people lost vs the trailing-baseline conversion × downstream
  conversion to enrolled × average contract value. Withheld while contract values are missing.
- **CAC payback (months):** Paid CAC ÷ (average monthly cash per new client × gross margin from
  the owner profile). Null with "needs gross margin in Owner notes" when absent.
- **Stuck leads:** contacts in a stage longer than twice that stage's median time, with names.
- **Creative fatigue:** per campaign weekly frequency, CPM and link CTR (link clicks ÷ impressions).
- **By assigned user:** consult → roadmap → enrolled by `owner_name`, only where GHL provides one.
- **Pace to target:** month to date vs the monthly target, and the run rate needed per remaining
  week.
- **Works / Fails / Verify:** each returns a value or null with a reason; hand-computed fixture
  tests; `verify.sql` gains independent recomputes of the leak and payback for the eval.

### 14. Presets and the report runner
- **Change:** `lib/analyst/presets.ts` with the eight presets. The welcome shows the demo's five
  buttons plus "More reports". `runReport` creates a thread, runs the turn, and on success inserts
  the report and its actions in one transaction. Migration **0018** (RLS on): `analyst_reports`
  (the spec's fields plus `turn_id`, `verification`, `definition_version`, `trigger`) and
  `analyst_actions` (metric, baseline, check date, status, grade). The KPI snapshot in
  `structured` is taken from the engine, not from the model.
- **Works:** the full report has the 8 sections, the biggest leak with its $ value and an actions
  table, and its numbers equal the dashboard for the range. The owner keeps chatting in the thread.
- **Fails:** a failed run stores no report and shows the reason plus Retry. A stale source puts a
  banner at the top of the stored report. A report with a flagged number is stored as `flagged`
  and says so at the top.
- **Verify:** tests for storage, schema validation and "nothing half-written"; an automated check
  that every stored number matches the engine for the range; `npm run smoke:analyst -- --report`
  prints the section list, the leak, the action count, tokens, cost and per-round timings; the
  eval gains 5 funnel-leak questions (≥ 29/30 overall).
  **Time limit rule:** if, across the wave's smoke runs, the final round's p95 exceeds 150 s, the
  total exceeds 240 s, or any run stops on `max_tokens`, the flagship report switches to
  server-driven sections (the same thread, several shorter rounds).

### 15. Reports → "AI reports" tab
- **Change:** a Digests | AI reports toggle on `/reports`. A list filtered by preset and date;
  open a report; continue the conversation; re-run the same range; mark an action done or skipped.
- **Works / Fails / Verify:** the list and a report render in both themes, with an empty state
  before the first report; screenshots; tests for the list API and the action status change.

### 16. Closed loop on actions, and "Analyze report history"
- **Change:** `lib/analyst/grade.ts` (pure): at or after the check date, the action's metric is
  recomputed from the engine → **worked / didn't / inconclusive (sample too small)**, with the
  numbers. Each new report is handed the due actions already graded. "Analyze report history"
  reads the last N reports' structured data and recomputes every KPI series from the engine; code
  computes the trend per area, the recurring findings (same area + metric in two or more reports)
  and the action hit rate, and the model explains them and says what to do next. Reports under an
  older definition version or with flagged data are marked "pre-correction" and never compared
  directly.
- **Works:** over 4 seeded weekly reports it flags the recurring problem and grades a past action
  against engine data.
- **Fails:** fewer than 2 reports: "Not enough history yet". A pre-correction report is labelled.
- **Verify:** grading tests (worked, didn't, too small a sample); recurrence and pre-correction
  tests; the behaviour suite gains the 4-report case.

### 17. Scheduled Weekly review
- **Change:** a cron route `/api/cron/analyst-weekly` with its own 300 s budget, self-gated to
  Monday at or after 6am local and idempotent per week (a partial unique index), Opus, stored. It
  can't run inside the dispatch (60 s steps), so it is **one new line in `vercel.json`**: called
  out because that file is only changed deliberately. Emailing the report stays out of scope, as
  the spec's out-of-scope list says; the Part C line "email it once Resend is configured" waits
  for your word.
- **Works:** Monday's report is in the AI reports tab by 7am, marked "scheduled".
- **Fails:** a run row with the reason; a failed run stores nothing and the next hourly call
  retries, at most 3 times, then a warning incident.
- **Verify:** gate, idempotency and retry-limit tests; the run row's reason text.

### 18. CLAUDE.md, memory and screenshots
- An "Analyst" section in CLAUDE.md (the runtime rules above, models, betas, costs, commands), the
  committed screenshot set, and the smoke and eval outputs linked from each wave's report.

---

## Migrations and deploy order (each wave)
`npm run db:migrate` first (0017 and 0018 only add tables, so they're safe for the deployed code),
then `git push`. One finding per commit; `npm run check` green between commits; I don't push and I
run nothing against production.

## What you run to prove each wave
- **Wave 1:** `npm run smoke:analyst -- --probe`, then `npm run smoke:analyst`.
- **Wave 2:** `npm run eval:analyst`, the screenshot review, and the lock-the-phone check.
- **Wave 3:** `npm run smoke:analyst -- --report` and `npm run eval:analyst` (30 questions).

## Cost estimates (to be replaced by measured smoke output)
With a 25–30K-token cached prefix: a chat answer on Opus about $0.15–0.40; an explain answer about
$0.10–0.25; a weekly review on Opus about $0.30–0.60; a full report about $1 on Opus and $2.50–4 on
Fable. These come from the price table, not from measurements.

## Risks
- **Structured output + tools + streaming** is documented but unproven for our shape: item 1
  settles it, with the `submit_answer` fallback named.
- **The 300 s function limit** for the Fable full report: resumable rounds, measured per round,
  with a stated rule for switching to server-driven sections.
- **Running past a disconnect** depends on `after()` behaving on Vercel as documented. Tested
  locally; the production proof is the lock-the-phone check. If it fails, the fallback is the
  client reconnecting and calling `continue`.
- **A deploy that edits the system prompt or a tool** changes the prefix for open threads.
  `drop_block` makes that a one-time loss of old reasoning, not an error.
- **Verifier strictness** could make answers stilted or trigger repairs. The eval reports the
  repair and flag rates; the rounding rules are the tuning point, not the ref requirement.
- **Eval cost and variance:** real money and a non-deterministic model. The first run is repeated
  three times to report variance.

## Out of scope
Emailing or exporting reports; per-person accounts; any write other than threads, turns, reports,
actions and approved owner notes; any change to an existing metric definition; retiring the Ask
card.
