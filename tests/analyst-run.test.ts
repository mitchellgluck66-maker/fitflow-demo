/**
 * The agent loop (Analyst plan item 5 + amendment 1) against a fake stream:
 * the happy path, the append-only log, repair then flagged, refusal /
 * max_tokens store nothing, one transient retry, stop, continue + resume,
 * compaction, spend actions on stale data, dropped-thinking logging, and the
 * orphan sweep. Plus the database store on PGlite.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { runMigrations } from '@/db/migrate';
import { MemoryAnalystStore, DbAnalystStore, type AnalystStore } from '@/lib/analyst/store';
import { historyFromLog, ledgerFromLog, runAnalystTurn, sweepOrphanTurns, ORPHAN_REASON, type AnalystClient, type AnalystEvent, type RunDeps, countRepairs } from '@/lib/analyst/run';
import type { AnalystTool, Freshness } from '@/lib/analyst/tools';
import type { BetaMessage } from '@/lib/analyst/api';
import { ANALYST_BETAS } from '@/lib/analyst/config';
import { SUBMIT_ANSWER_TOOL } from '@/lib/analyst/api';

const freshness: Freshness = { stale: false, line: 'data fresh — test', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] };
const tools: AnalystTool[] = [
  {
    definition: { name: 'get_scorecard', description: 'x'.repeat(50), strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    run: async () => ({ range: { start: '2026-09-20', end: '2026-09-26', label: 'Last week' }, currency: 'CAD', fx: '', data: { kpis: { enrollments: { current: 8, previous: 4 } }, marketing: { spendCents: 369_768 } } }),
  },
];

type Scripted = Partial<BetaMessage> & { content: BetaMessage['content']; stop_reason: BetaMessage['stop_reason'] };
const msg = (content: BetaMessage['content'], stop: BetaMessage['stop_reason'] = 'end_turn', usage: Partial<BetaMessage['usage']> = {}, extra: Record<string, unknown> = {}): Scripted =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage }, ...extra }) as unknown as Scripted;
const think = (text: string) => ({ type: 'thinking', thinking: text, signature: 'sig' }) as unknown as BetaMessage['content'][number];
const toolUse = (id: string, name = 'get_scorecard', input: unknown = {}) => ({ type: 'tool_use', id, name, input }) as unknown as BetaMessage['content'][number];
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as BetaMessage['content'][number];
const answerJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'answer',
    headline: { text: 'Enrollments doubled to {r1:data.kpis.enrollments.current}.' },
    sections: [{ key: 'what_happened', body_md: '**{r1:data.kpis.enrollments.current}** enrollments last week, up from {r1:data.kpis.enrollments.previous}.' }],
    actions: [],
    findings: [],
    note_proposals: [],
    clarifying_question: '',
    ...over,
  });

/** A scripted client: each stream() pops the next message (or throws the next error), recording the request. */
function fakeClient(script: Array<Scripted | Error>, compaction?: Scripted): AnalystClient & { requests: Array<Record<string, unknown>>; compactionRequests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const compactionRequests: Array<Record<string, unknown>> = [];
  return {
    requests,
    compactionRequests,
    beta: {
      messages: {
        stream: (params) => {
          requests.push(params as unknown as Record<string, unknown>);
          const next = script.shift();
          // Oct 7 item 6: a scripted message may carry `deltas` — the answer text streamed in chunks (text_delta events).
          const deltas = ((next as { deltas?: string[] } | undefined)?.deltas ?? []).map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } }));
          const events = [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reading the scorecard' } },
            { type: 'content_block_stop', index: 0 },
            ...(deltas.length ? [{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, ...deltas, { type: 'content_block_stop', index: 1 }] : []),
          ] as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent[];
          return {
            async *[Symbol.asyncIterator]() {
              if (next instanceof Error) throw next;
              for (const e of events) yield e;
            },
            finalMessage: async () => {
              if (next instanceof Error) throw next;
              if (!next) throw new Error('script exhausted');
              return next as unknown as BetaMessage;
            },
          };
        },
        create: async (params) => {
          compactionRequests.push(params as unknown as Record<string, unknown>);
          if (!compaction) throw new Error('no compaction scripted');
          return compaction as unknown as BetaMessage;
        },
      },
    },
  };
}

async function setup(store: AnalystStore, over: Partial<RunDeps> = {}) {
  const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
  const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'c1', question: 'How did we do?', kind: 'ask', pageContext: null });
  const events: AnalystEvent[] = [];
  const deps: RunDeps = { store, client: fakeClient([]), contract: 'CONTRACT', brief: { text: 'BRIEF', hash: 'h' }, tools, freshness, userTurn: 'Today: 2026-09-30.\nHow did we do?', allowedUsd: 3, retryDelayMs: 1, onEvent: (e) => events.push(e), ...over };
  return { thread, turn, events, deps };
}

const happyScript = () => [msg([think('Reading'), toolUse('tu1')], 'tool_use', { cache_creation_input_tokens: 900 }), msg([text(answerJson())], 'end_turn', { cache_read_input_tokens: 900 })];

describe('the loop (memory store)', () => {
  it('happy path: tool round then a verified answer; events in order; the log is replayable and byte-stable', async () => {
    const store = new MemoryAnalystStore();
    const client = fakeClient(happyScript());
    const { thread, turn, events, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.answer?.headline.text).toBe('Enrollments doubled to {r1:data.kpis.enrollments.current}.');
    expect(out.rendered).toMatchObject({ headline: 'Enrollments doubled to 8.', sections: [{ key: 'what_happened', body_md: '**8** enrollments last week, up from 4.' }] }); // rendered by the server
    expect(out.flagged).toEqual([]);
    expect(out.rounds).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['notice', 'status', 'round', 'tools', 'status', 'round', 'answer', 'usage', 'done']);
    // Item D: the split (no counter here → ≈ from characters, labelled) sums to the cost and is stored on the turn.
    const usageEvent = events.find((e) => e.type === 'usage') as { split: { approximate: boolean; answerTokens: number; inputUsd: number; cacheReadUsd: number; cacheWriteUsd: number; thinkingUsd: number; answerUsd: number } };
    expect(usageEvent.split.approximate).toBe(true);
    expect(usageEvent.split.answerTokens).toBeGreaterThan(0);
    expect(usageEvent.split.inputUsd + usageEvent.split.cacheReadUsd + usageEvent.split.cacheWriteUsd + usageEvent.split.thinkingUsd + usageEvent.split.answerUsd).toBeCloseTo(out.costUsd, 6);
    expect((await store.getTurn(turn.id))?.usage).toMatchObject({ answerTokens: usageEvent.split.answerTokens, answerUsd: usageEvent.split.answerUsd });
    const counted = await setup(new MemoryAnalystStore(), { client: fakeClient(happyScript()), countTokens: async (text) => text.length });
    const o2 = await runAnalystTurn(counted.thread.id, counted.turn.id, counted.deps);
    expect(o2.split).toMatchObject({ approximate: false });
    expect(events.filter((e) => e.type === 'round')).toEqual([expect.objectContaining({ stopReason: 'tool_use', cacheWriteTokens: 900, cacheSharePct: 0, toolCalls: 1 }), expect.objectContaining({ stopReason: 'end_turn', cacheReadTokens: 900, cacheSharePct: 47.4, toolCalls: 0 })]);
    expect(events[3]).toMatchObject({ type: 'tools', calls: [{ ref: 'r1', name: 'get_scorecard', label: 'Reading the scorecard…' }] });
    // Cost: 1000 in + 900 cache write + 200 out, then 1000 in + 900 cache read + 200 out on Opus.
    expect(out.costUsd).toBeCloseTo((2000 * 4 + 900 * 5 + 900 * 0.2 + 400 * 20) / 1e6, 8);
    const rows = await store.listMessages(thread.id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool_results', 'assistant']);
    for (const r of rows) expect(JSON.stringify(JSON.parse(r.apiJson))).toBe(r.apiJson);
    // The second request replayed the first round byte for byte, including the thinking block; the two user
    // messages carry the moving cache breakpoints (item 2) which the stored rows do NOT.
    const second = client.requests[1] as { messages: Array<{ content: Array<Record<string, unknown>> }>; betas: string[] };
    expect(second.messages.length).toBe(3);
    expect(JSON.stringify(second.messages[1])).toBe(rows[1].apiJson);
    expect(second.messages[0].content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(second.messages[2].content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(rows[0].apiJson).not.toContain('cache_control');
    expect(rows[2].apiJson).not.toContain('cache_control');
    expect(second.betas).toEqual([ANALYST_BETAS.displayUpdates, ANALYST_BETAS.bindingControls]);
    expect((await store.getTurn(turn.id))?.status).toBe('done');
    expect((await store.getThread(thread.id))?.title).toBe('How did we do?');
    expect(ledgerFromLog(rows).ledger.resolve('r1:data.kpis.enrollments.current')).toBe(8);
  });

  it('item 1: a round with several tool calls runs them CONCURRENTLY, refs in call order, one tool_results message, toolCalls = N', async () => {
    const store = new MemoryAnalystStore();
    let inFlight = 0;
    let peak = 0;
    const slowTools: AnalystTool[] = [
      ...tools,
      {
        definition: { name: 'get_funnel', description: 'y'.repeat(50), strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
        run: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight -= 1;
          return { range: null, currency: 'CAD', fx: '', data: { stages: [{ key: 'applied', count: 52 }] } };
        },
      },
    ];
    slowTools[0] = { ...slowTools[0], run: async (...a) => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight -= 1; return tools[0].run(...a); } };
    const client = fakeClient([
      msg([think('Gathering'), toolUse('tu1', 'get_scorecard'), toolUse('tu2', 'get_funnel'), toolUse('tu3', 'get_funnel')], 'tool_use'),
      msg([text(answerJson())], 'end_turn'),
    ]);
    const { thread, turn, events, deps } = await setup(store, { client, tools: slowTools });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(peak).toBe(3); // all three ran at once, not one after another
    expect(events.find((e) => e.type === 'round')).toMatchObject({ toolCalls: 3 });
    expect(events.find((e) => e.type === 'tools')).toMatchObject({ calls: [{ ref: 'r1', name: 'get_scorecard' }, { ref: 'r2', name: 'get_funnel' }, { ref: 'r3', name: 'get_funnel' }] });
    const rows = await store.listMessages(thread.id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool_results', 'assistant']);
    const results = (JSON.parse(rows[2].apiJson) as { content: Array<{ tool_use_id: string }> }).content;
    expect(results.map((c) => c.tool_use_id)).toEqual(['tu1', 'tu2', 'tu3']);
    expect(ledgerFromLog(rows).ledger.resolve('r3:data.stages[0].count')).toBe(52);
  });

  it('item 6: note_proposals go to the handler (status says how many were saved); without a handler they are listed, never dropped silently', async () => {
    const store = new MemoryAnalystStore();
    const proposing = answerJson({ note_proposals: ['2026-09-30: Meta cap $4,000 CAD a month from October'] });
    const seen: string[][] = [];
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(proposing)])]);
    const { thread, turn, events, deps } = await setup(store, { client, onProposals: async (t) => { seen.push(t); return { saved: 1, skipped: 0 }; } });
    expect((await runAnalystTurn(thread.id, turn.id, deps)).status).toBe('done');
    expect(seen).toEqual([['2026-09-30: Meta cap $4,000 CAD a month from October']]);
    expect(events.some((e) => e.type === 'status' && e.text === '1 note proposal saved for your approval (Setup → Analyst → Notes).')).toBe(true);
    const bare = await setup(new MemoryAnalystStore(), { client: fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(proposing)])]) });
    await runAnalystTurn(bare.thread.id, bare.turn.id, bare.deps);
    expect(bare.events.some((e) => e.type === 'status' && e.text.startsWith('1 note proposal (not saved — no handler): 2026-09-30: Meta cap'))).toBe(true);
  });

  it('a raw digit gets ONE TARGETED repair: the request carries the repair format, only the listed field comes back and is spliced in, the rest is byte-identical (Oct 7 item 2a)', async () => {
    const store = new MemoryAnalystStore();
    const bad = answerJson({ headline: { text: 'Enrollments hit 9.' } });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)]), msg([text(JSON.stringify({ fields: [{ path: 'headline', text: 'Enrollments hit {r1:data.kpis.enrollments.current}.' }, { path: 'what_happened', text: 'NOT asked for' }] }))])]);
    const { thread, turn, events, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.flagged).toEqual([]);
    const repairReq = client.requests[2] as { output_config: { format?: { schema: { properties: Record<string, unknown> } } }; tools: Array<{ name: string }> };
    expect(Object.keys(repairReq.output_config.format!.schema.properties)).toEqual(['fields']); // the repair format, not the answer's
    expect(repairReq.tools.some((t) => t.name === 'submit_repair')).toBe(false);
    expect(events.filter((e) => e.type === 'repair')).toEqual([{ type: 'repair', targeted: true, paths: ['headline'], problems: [{ kind: 'digits', section: 'headline', text: '9', reason: expect.stringContaining('"9" is a number written as digits') }] }]);
    expect(events.some((e) => e.type === 'status' && e.text === 'Repaired 1 field (headline) · ignored 1 unasked-for (what_happened)')).toBe(true);
    expect(out.answer?.headline.text).toBe('Enrollments hit {r1:data.kpis.enrollments.current}.');
    expect(out.answer?.sections).toEqual(JSON.parse(bad).sections); // untouched
    expect(out.rendered?.headline).toBe('Enrollments hit 8.');
    const repairUser = JSON.parse((await store.listMessages(thread.id))[4].apiJson) as { content: string };
    expect(repairUser.content).toMatch(/^Your answer was not accepted\. Return ONLY these fields/);
    expect(repairUser.content).toContain('- headline:\n    · "9" — "9" is a number written as digits');
    expect(events.some((e) => e.type === 'status' && e.text === 'Repairing the answer…')).toBe(true);
    expect(events.find((e) => e.type === 'answer')).toMatchObject({ repaired: true, repairs: 1 });
    expect(events.filter((e) => e.type === 'status' && e.text === 'Repairing the answer…').length).toBe(1);
    // Item 4: the repair event names every problem and the rule it came from — the count the smoke line prints.
    expect(countRepairs(events)).toBe(1);
    const roles = (await store.listMessages(thread.id)).map((r) => r.role);
    expect(roles).toEqual(['user', 'assistant', 'tool_results', 'assistant', 'user', 'assistant']);
  });

  it('Oct 7 item 6: the first section is verified the moment it closes in the stream — before the final message — and the turn records the seconds', async () => {
    const store = new MemoryAnalystStore();
    const json = answerJson();
    const cut = json.indexOf('"why"') > 0 ? json.indexOf('"why"') : Math.floor(json.length / 2);
    let t = 0;
    const now = () => (t += 5_000); // every clock read is 5 s later
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(json)], 'end_turn', {}, { deltas: [json.slice(0, 20), json.slice(20, cut), json.slice(cut)] })]);
    const { thread, turn, events, deps } = await setup(store, { client, now });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    const section = events.find((e) => e.type === 'section');
    expect(section).toMatchObject({ type: 'section', key: 'what_happened', verified: true, index: 0, body_md: '**8** enrollments last week, up from 4.' }); // rendered from the ledger the moment it closed (Wave 2 tune-up 3)
    expect(events.find((e) => e.type === 'round')).toMatchObject({ type: 'round', seconds: expect.any(Number), firstTokenSeconds: expect.any(Number) });
    expect(events.indexOf(section!)).toBeLessThan(events.findIndex((e) => e.type === 'answer'));
    expect(out.firstSectionSeconds).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'answer')).toMatchObject({ firstSectionSeconds: out.firstSectionSeconds });
    // A first section with a bad ref streams as NOT verified (and the turn repairs it as usual).
    const bad = answerJson({ sections: [{ key: 'what_happened', body_md: '{r9:data.nope} enrollments.' }] });
    const client2 = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)], 'end_turn', {}, { deltas: [bad] }), msg([text(JSON.stringify({ fields: [{ path: 'what_happened', text: '{r1:data.kpis.enrollments.current} enrollments.' }] }))])]);
    const s2 = await setup(new MemoryAnalystStore(), { client: client2 });
    const out2 = await runAnalystTurn(s2.thread.id, s2.turn.id, s2.deps);
    expect(out2.status).toBe('done');
    expect(s2.events.filter((e) => e.type === 'section')).toEqual([{ type: 'section', key: 'what_happened', verified: false, seconds: expect.any(Number), index: 0, body_md: '[no source] enrollments.' }]); // once per turn; the repair round does not re-emit
    // Wave 2 tune-up 3: EVERY section streams as it closes, in order, each verified on its own.
    const two = answerJson({ sections: [{ key: 'what_happened', body_md: '**{r1:data.kpis.enrollments.current}** enrollments.' }, { key: 'why', body_md: 'Spend was {r1:data.marketing.spendCents}.' }] });
    const client3 = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(two)], 'end_turn', {}, { deltas: [two.slice(0, two.indexOf('"why"') - 2), two.slice(two.indexOf('"why"') - 2)] })]);
    const s3 = await setup(new MemoryAnalystStore(), { client: client3 });
    expect((await runAnalystTurn(s3.thread.id, s3.turn.id, s3.deps)).status).toBe('done');
    expect(s3.events.filter((e) => e.type === 'section').map((e) => (e.type === 'section' ? [e.index, e.key, e.verified, e.body_md] : null))).toEqual([[0, 'what_happened', true, '**8** enrollments.'], [1, 'why', true, 'Spend was $3,697.68 CAD.']]);
    expect(out2.flagged).toEqual([]);
  });

  it('a targeted repair that returns nothing usable keeps the original fields, marked; a structure problem regenerates the whole answer (full repair)', async () => {
    const store = new MemoryAnalystStore();
    const bad = answerJson({ headline: { text: 'Enrollments hit 9.' } });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)]), msg([text('not json')])]);
    const { thread, turn, events, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(events.some((e) => e.type === 'status' && e.text.startsWith('Repair returned nothing usable (the repair was not valid JSON)'))).toBe(true);
    expect(out.flagged.map((f) => [f.kind, f.text])).toEqual([['digits', '9']]);
    expect(out.rendered?.headline).toBe('Enrollments hit [unverified: 9].');
    // Structure: the sections are out of order → not a text-field problem → the full answer is asked for again (the answer format).
    const store2 = new MemoryAnalystStore();
    const disordered = answerJson({ sections: [{ key: 'do_this', body_md: 'x' }, { key: 'what_happened', body_md: 'y' }] });
    const client2 = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(disordered)]), msg([text(answerJson())])]);
    const s2 = await setup(store2, { client: client2 });
    const out2 = await runAnalystTurn(s2.thread.id, s2.turn.id, s2.deps);
    expect(out2.status).toBe('done');
    expect(s2.events.filter((e) => e.type === 'repair')).toEqual([{ type: 'repair', targeted: false, paths: [], problems: [{ kind: 'structure', section: 'answer', text: '', reason: expect.stringMatching(/order/) }] }]);
    const req2 = client2.requests[2] as { output_config: { format?: { schema: { properties: Record<string, unknown> } } } };
    expect(Object.keys(req2.output_config.format!.schema.properties)).toContain('headline'); // the answer format
    expect(s2.events.some((e) => e.type === 'round' && typeof e.costUsd === 'number')).toBe(true);
  });

  it('still wrong after the repair: the answer is shown with the digit and the unknown ref marked, never silently', async () => {
    const store = new MemoryAnalystStore();
    const bad = answerJson({ headline: { text: 'Enrollments hit 9, spend {r9:data.nope}.' } });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)]), msg([text(bad)])]);
    const { thread, turn, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.flagged.map((f) => [f.kind, f.text])).toEqual([['ref', '{r9:data.nope}'], ['digits', '9']]);
    expect(out.rendered?.headline).toBe('Enrollments hit [unverified: 9], spend [no source].');
  });

  it('a refusal or a max_tokens stop stores nothing from the round and fails with a retryable error', async () => {
    for (const stop of ['refusal', 'max_tokens'] as const) {
      const store = new MemoryAnalystStore();
      const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text('{')], stop)]);
      const { thread, turn, events, deps } = await setup(store, { client });
      const out = await runAnalystTurn(thread.id, turn.id, deps);
      expect(out.status).toBe('failed');
      expect((await store.listMessages(thread.id)).map((r) => r.role)).toEqual(['user', 'assistant', 'tool_results']);
      expect(events.at(-2)).toMatchObject({ type: 'error', retryable: true, message: expect.stringMatching(/^Analyst request failed: /) });
      expect((await store.getTurn(turn.id))?.status).toBe('failed');
    }
  });

  it('a transient API error is retried once, rebuilt from the log; a permanent one fails at once', async () => {
    const store = new MemoryAnalystStore();
    const transient = new Anthropic.APIConnectionError({ message: 'socket hang up' });
    const client = fakeClient([transient, ...happyScript()]);
    const { thread, turn, deps } = await setup(store, { client });
    expect((await runAnalystTurn(thread.id, turn.id, deps)).status).toBe('done');
    expect(client.requests.length).toBe(3);
    expect(JSON.stringify(client.requests[0])).toBe(JSON.stringify(client.requests[1]));

    const store2 = new MemoryAnalystStore();
    const permanent = new Anthropic.BadRequestError(400, { error: { type: 'invalid_request_error', message: 'bad schema' } }, 'bad', new Headers());
    const client2 = fakeClient([permanent, ...happyScript()]);
    const s2 = await setup(store2, { client: client2 });
    const out = await runAnalystTurn(s2.thread.id, s2.turn.id, s2.deps);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/Anthropic 400/);
    expect(client2.requests.length).toBe(1);
  });

  it('Stop ends the turn before the next round; nothing from an unfinished round is stored', async () => {
    const store = new MemoryAnalystStore();
    const client = fakeClient(happyScript());
    const { thread, turn, events, deps } = await setup(store, { client });
    const original = client.beta.messages.stream;
    client.beta.messages.stream = (p) => {
      void store.updateTurn(turn.id, { stopRequested: true }); // "Stop" pressed while round 1 streams
      return original(p);
    };
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('stopped');
    expect(events.map((e) => e.type)).toContain('stopped');
    expect((await store.listMessages(thread.id)).map((r) => r.role)).toEqual(['user', 'assistant', 'tool_results']);
  });

  it('past the time budget the turn persists and emits continue; a second run resumes from the log without re-adding the user turn', async () => {
    const store = new MemoryAnalystStore();
    const client = fakeClient(happyScript());
    let t = 0;
    const { thread, turn, events, deps } = await setup(store, { client, now: () => (t += 200_000), budgetMs: 240_000 });
    const first = await runAnalystTurn(thread.id, turn.id, deps);
    expect(first.status).toBe('continue');
    expect(events.at(-1)?.type).toBe('continue');
    expect((await store.getTurn(turn.id))?.status).toBe('running');
    const second = await runAnalystTurn(thread.id, turn.id, { ...deps, now: () => Date.now() });
    expect(second.status).toBe('done');
    expect((await store.listMessages(thread.id)).filter((r) => r.role === 'user').length).toBe(1);
  });

  it('a running cost past the allowed amount pauses for confirmation between rounds', async () => {
    const store = new MemoryAnalystStore();
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use', { input_tokens: 200_000, output_tokens: 20_000 }), ...happyScript()]);
    const { thread, turn, events, deps } = await setup(store, { client, allowedUsd: 1 });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('needs_confirmation');
    expect(events.find((e) => e.type === 'needs_confirmation')).toMatchObject({ reason: expect.stringMatching(/above the \$1\.00 USD allowed/) });
    expect((await store.getTurn(turn.id))?.status).toBe('needs_confirmation');
  });

  it('after a completed turn past the token limit, one compaction request (same system + tools, no format) adds a compaction row the next request starts with', async () => {
    const store = new MemoryAnalystStore();
    const compaction = msg([{ type: 'compaction', content: 'Summary.', signature: 'c' } as unknown as BetaMessage['content'][number]], 'compaction', { input_tokens: 0, output_tokens: 0 });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(answerJson())], 'end_turn', { input_tokens: 400_000 })], compaction);
    const { thread, turn, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.compacted).toBe(true);
    const req = client.compactionRequests[0] as { system: unknown; tools: unknown; compaction: unknown; output_config?: { format?: unknown } };
    expect(req.system).toEqual((client.requests[0] as { system: unknown }).system);
    expect(req.tools).toEqual((client.requests[0] as { tools: unknown }).tools);
    expect(req.compaction).toMatchObject({ type: 'summarize' });
    expect(req.output_config?.format).toBeUndefined();
    const rows = await store.listMessages(thread.id);
    expect(rows.at(-1)?.role).toBe('compaction');
    const next = historyFromLog(rows);
    expect(next.carriesCompaction).toBe(true);
    expect(next.messages.length).toBe(1);
    // A second turn carries the block first and the compaction beta.
    const { turn: t2 } = await store.createTurn({ threadId: thread.id, clientTurnId: 'c2', question: 'And spend?', kind: 'ask', pageContext: null });
    const client2 = fakeClient([msg([text(answerJson({ headline: { text: 'Fine.' }, sections: [{ key: 'what_happened', body_md: 'Nothing new.' }] }))])]);
    await runAnalystTurn(thread.id, t2.id, { ...deps, client: client2, userTurn: 'And spend?' });
    const r = client2.requests[0] as { messages: Array<{ content: unknown }>; betas: string[] };
    expect(r.betas).toContain(ANALYST_BETAS.compaction);
    expect(JSON.stringify(r.messages[0].content)).toContain('"type":"compaction"');
  });

  it('a spend action on stale data is replaced by the server\'s hold with a stated reason — no repair round (Wave 2 tune-up 1)', async () => {
    const store = new MemoryAnalystStore();
    const spend = answerJson({ actions: [{ action: 'Move $500 to Broad', why: 'x', owner: 'Jake', kind: 'spend', campaign: 'account', spend_change: 'shift', expected_impact: 'unknown', confidence: 'low', metric: 'paid_cac', check_date: '2026-10-07' }] });
    const client = fakeClient([msg([toolUse('tu1', 'get_scorecard', {})], 'tool_use'), msg([text(spend)])]);
    const gated: AnalystTool[] = [{ ...tools[0], run: async () => ({ range: { start: '2026-09-20', end: '2026-09-26', label: 'Last week' }, currency: 'CAD', fx: '', data: { kpis: { enrollments: { current: 8, previous: 4 } }, spendGates: { account: { campaign: 'account', decision: 'hold', basis: 'Meta Ads spend stale for 9.0 h', needsEnrollments: 0, needsWeeks: 0 }, campaigns: [] } } }) }];
    const { thread, turn, events, deps } = await setup(store, { client, tools: gated, freshness: { stale: true, line: 'STALE — Meta Ads spend (last completed 9.0 h ago)', phrase: 'Meta Ads spend stale for 9.0 h', oldestAgeMinutes: 540, sources: [] } });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(events[0]).toEqual({ type: 'notice', text: 'STALE — Meta Ads spend (last completed 9.0 h ago)', stale: true });
    expect(out.status).toBe('done');
    expect(out.rounds).toBe(1); // no repair round (the happy path is 1 round)
    expect(out.spendDecisions).toEqual([{ campaign: 'account', gate: 'hold', basis: 'Meta Ads spend stale for 9.0 h', decision: 'hold', decidedBy: 'server', ref: 'r1:data.spendGates.account.decision' }]);
    expect(out.rendered?.actions[0]).toMatchObject({ action: 'Hold account: Meta Ads spend stale for 9.0 h', why: 'A data source is stale; no spend change until the sync completes.', gate: 'hold', decidedBy: 'server' });
    expect(out.flagged).toEqual([]);
    expect(out.answer?.sections.at(-1)?.body_md).toContain('A spend recommendation was replaced by a hold: STALE — Meta Ads spend');
    expect(events.some((e) => e.type === 'status' && e.text === 'spend action "Move $500 to Broad" (shift account) replaced by a hold: a data source is stale')).toBe(true);
  });

  it('dropped thinking (input_transformations) is logged as a status, not an error', async () => {
    const store = new MemoryAnalystStore();
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(answerJson())], 'end_turn', {}, { input_transformations: [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }] })]);
    const { thread, turn, events, deps } = await setup(store, { client });
    expect((await runAnalystTurn(thread.id, turn.id, deps)).status).toBe('done');
    expect(events.some((e) => e.type === 'status' && e.text.includes('Earlier reasoning was dropped'))).toBe(true);
  });

  it('a submit_answer-mode thread reads the answer from the tool call', async () => {
    const store = new MemoryAnalystStore();
    const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'submit_answer', briefHash: 'h' });
    const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'c1', question: 'q', kind: 'ask', pageContext: null });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([toolUse('tu2', SUBMIT_ANSWER_TOOL, JSON.parse(answerJson()))], 'tool_use')]);
    const out = await runAnalystTurn(thread.id, turn.id, { store, client, contract: 'C', brief: { text: 'B', hash: 'h' }, tools, freshness, userTurn: 'q', allowedUsd: 3 });
    expect(out.status).toBe('done');
    expect(out.answer?.headline.text).toBe('Enrollments doubled to {r1:data.kpis.enrollments.current}.');
    expect(out.rendered).toMatchObject({ headline: 'Enrollments doubled to 8.', sections: [{ key: 'what_happened', body_md: '**8** enrollments last week, up from 4.' }] }); // rendered by the server
    expect((client.requests[0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['get_scorecard', SUBMIT_ANSWER_TOOL]);
  });

  it('amendment 1: a running turn with a heartbeat older than 5 minutes is swept to failed with the reason; a healthy long turn is not', async () => {
    const store = new MemoryAnalystStore();
    const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
    const { turn: dead } = await store.createTurn({ threadId: thread.id, clientTurnId: 'dead', question: 'q', kind: 'ask', pageContext: null });
    const { turn: alive } = await store.createTurn({ threadId: thread.id, clientTurnId: 'alive', question: 'q', kind: 'ask', pageContext: null });
    const now = Date.now();
    (await store.getTurn(dead.id))!.heartbeatAt = new Date(now - 6 * 60_000);
    (await store.getTurn(alive.id))!.heartbeatAt = new Date(now - 4 * 60_000);
    const swept = await sweepOrphanTurns(store, new Date(now));
    expect(swept.map((t) => t.id)).toEqual([dead.id]);
    expect((await store.getTurn(dead.id))).toMatchObject({ status: 'failed', error: ORPHAN_REASON });
    expect((await store.getTurn(dead.id))?.events.at(-1)).toMatchObject({ type: 'error', message: `Analyst request failed: ${ORPHAN_REASON}`, retryable: true });
    expect((await store.getTurn(alive.id))?.status).toBe('running');
  });
});

describe('the database store (PGlite)', () => {
  const store = new DbAnalystStore();
  beforeAll(async () => {
    await runMigrations();
  });

  it('appends messages atomically with consecutive seqs, round-trips api_json as text, and lists in order', async () => {
    const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
    const json = '{"role":"assistant","content":[{"type":"thinking","thinking":"z","signature":"s"},{"type":"text","text":"1.0"}]}';
    const rows = await store.appendMessages(thread.id, [{ turnId: null, role: 'user', apiJson: '{"role":"user","content":"hi"}' }, { turnId: null, role: 'assistant', apiJson: json }]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    const more = await store.appendMessages(thread.id, [{ turnId: null, role: 'user', apiJson: '{"role":"user","content":"again"}' }]);
    expect(more[0].seq).toBe(3);
    const listed = await store.listMessages(thread.id);
    expect(listed[1].apiJson).toBe(json); // key order and "1.0" untouched
    expect((await store.listThreads()).map((t) => t.id)).toContain(thread.id);
  });

  it('a repeated client turn id returns the same turn; the live turn is found; events append with a heartbeat; spend sums; orphans sweep', async () => {
    const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
    const a = await store.createTurn({ threadId: thread.id, clientTurnId: 'same', question: 'q', kind: 'ask', pageContext: { page: 'funnel' } });
    const b = await store.createTurn({ threadId: thread.id, clientTurnId: 'same', question: 'q', kind: 'ask', pageContext: null });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.turn.id).toBe(a.turn.id);
    expect((await store.liveTurn(thread.id))?.id).toBe(a.turn.id);
    expect(await store.appendEvent(a.turn.id, { type: 'status', text: 'one' })).toBe(1);
    expect(await store.appendEvent(a.turn.id, { type: 'status', text: 'two' })).toBe(2);
    expect((await store.getTurn(a.turn.id))?.events.map((e) => e.text)).toEqual(['one', 'two']);
    await store.updateTurn(a.turn.id, { costUsd: 0.5 });
    expect(await store.spentUsdSince(new Date(Date.now() - 60_000))).toBeGreaterThanOrEqual(0.5);
    expect(await store.sweepOrphans(new Date(Date.now() - 60_000), 'x')).toEqual([]); // heartbeat is fresh
    expect((await store.sweepOrphans(new Date(Date.now() + 60_000), 'orphaned')).map((t) => t.id)).toContain(a.turn.id);
    expect((await store.getTurn(a.turn.id))).toMatchObject({ status: 'failed', error: 'orphaned' });
    expect(await store.liveTurn(thread.id)).toBeNull();
  });
});
