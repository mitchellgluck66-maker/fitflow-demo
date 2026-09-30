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
import { historyFromLog, ledgerFromLog, runAnalystTurn, sweepOrphanTurns, ORPHAN_REASON, type AnalystClient, type AnalystEvent, type RunDeps } from '@/lib/analyst/run';
import type { AnalystTool, Freshness } from '@/lib/analyst/tools';
import type { BetaMessage } from '@/lib/analyst/api';
import { ANALYST_BETAS } from '@/lib/analyst/config';
import { SUBMIT_ANSWER_TOOL } from '@/lib/analyst/api';

const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
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
    headline: { text: 'Enrollments doubled to 8.', ref: 'r1:data.kpis.enrollments.current' },
    sections: [{ key: 'what_happened', body_md: '**8** enrollments last week, up from 4.', numbers: [{ text: '8', ref: 'r1:data.kpis.enrollments.current' }, { text: '4', ref: 'r1:data.kpis.enrollments.previous' }] }],
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
          const events = [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reading the scorecard' } },
            { type: 'content_block_stop', index: 0 },
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
    expect(out.answer?.headline.text).toBe('Enrollments doubled to 8.');
    expect(out.flagged).toEqual([]);
    expect(out.rounds).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['notice', 'status', 'round', 'tools', 'status', 'round', 'answer', 'usage', 'done']);
    expect(events.filter((e) => e.type === 'round')).toEqual([expect.objectContaining({ stopReason: 'tool_use', cacheWriteTokens: 900, toolCalls: 1 }), expect.objectContaining({ stopReason: 'end_turn', cacheReadTokens: 900, toolCalls: 0 })]);
    expect(events[3]).toMatchObject({ type: 'tools', calls: [{ ref: 'r1', name: 'get_scorecard', label: 'Reading the scorecard…' }] });
    // Cost: 1000 in + 900 cache write + 200 out, then 1000 in + 900 cache read + 200 out on Opus.
    expect(out.costUsd).toBeCloseTo((2000 * 4 + 900 * 5 + 900 * 0.2 + 400 * 20) / 1e6, 8);
    const rows = await store.listMessages(thread.id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool_results', 'assistant']);
    for (const r of rows) expect(JSON.stringify(JSON.parse(r.apiJson))).toBe(r.apiJson);
    // The second request replayed the first round byte for byte, including the thinking block.
    const second = client.requests[1] as { messages: unknown[]; betas: string[] };
    expect(second.messages.length).toBe(3);
    expect(JSON.stringify(second.messages[1])).toBe(rows[1].apiJson);
    expect(second.betas).toEqual([ANALYST_BETAS.displayUpdates, ANALYST_BETAS.bindingControls]);
    expect((await store.getTurn(turn.id))?.status).toBe('done');
    expect((await store.getThread(thread.id))?.title).toBe('How did we do?');
    expect(ledgerFromLog(rows).ledger.resolve('r1:data.kpis.enrollments.current')).toBe(8);
  });

  it('a wrong number gets ONE repair turn; a correct second answer is accepted as repaired', async () => {
    const store = new MemoryAnalystStore();
    const bad = answerJson({ headline: { text: 'Enrollments hit 9.', ref: 'r1:data.kpis.enrollments.current' } });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)]), msg([text(answerJson())])]);
    const { thread, turn, events, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.flagged).toEqual([]);
    expect(events.some((e) => e.type === 'status' && e.text === 'Repairing the answer…')).toBe(true);
    expect((events.find((e) => e.type === 'answer') as { repaired: boolean }).repaired).toBe(true);
    const roles = (await store.listMessages(thread.id)).map((r) => r.role);
    expect(roles).toEqual(['user', 'assistant', 'tool_results', 'assistant', 'user', 'assistant']);
    const repair = JSON.parse((await store.listMessages(thread.id))[4].apiJson) as { content: string };
    expect(repair.content).toContain('"9" does not equal r1:data.kpis.enrollments.current = 8');
  });

  it('still wrong after the repair: the answer is shown with the number flagged, never silently', async () => {
    const store = new MemoryAnalystStore();
    const bad = answerJson({ headline: { text: 'Enrollments hit 9.', ref: 'r1:data.kpis.enrollments.current' } });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(bad)]), msg([text(bad)])]);
    const { thread, turn, deps } = await setup(store, { client });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(out.status).toBe('done');
    expect(out.flagged.map((f) => f.reason)).toEqual(['"9" does not equal r1:data.kpis.enrollments.current = 8 (count)']);
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
    const client2 = fakeClient([msg([text(answerJson({ headline: { text: 'Fine.', ref: '' }, sections: [{ key: 'what_happened', body_md: 'Nothing new.', numbers: [] }] }))])]);
    await runAnalystTurn(thread.id, t2.id, { ...deps, client: client2, userTurn: 'And spend?' });
    const r = client2.requests[0] as { messages: Array<{ content: unknown }>; betas: string[] };
    expect(r.betas).toContain(ANALYST_BETAS.compaction);
    expect(JSON.stringify(r.messages[0].content)).toContain('"type":"compaction"');
  });

  it('a spend action on stale data is repaired, then stripped with a stated reason', async () => {
    const store = new MemoryAnalystStore();
    const spend = answerJson({ actions: [{ action: 'Move $500 to Broad', why: 'x', owner: 'Jake', kind: 'spend', expected_impact_ref: '', expected_impact: 'unknown', confidence: 'low', metric: 'paid_cac', check_date: '2026-10-07' }] });
    const client = fakeClient([msg([toolUse('tu1')], 'tool_use'), msg([text(spend)]), msg([text(spend)])]);
    const { thread, turn, events, deps } = await setup(store, { client, freshness: { stale: true, line: 'STALE — Meta Ads spend (last completed 9.0 h ago)', sources: [] } });
    const out = await runAnalystTurn(thread.id, turn.id, deps);
    expect(events[0]).toEqual({ type: 'notice', text: 'STALE — Meta Ads spend (last completed 9.0 h ago)', stale: true });
    expect(out.status).toBe('done');
    expect(out.answer?.actions).toEqual([]);
    expect(out.answer?.sections.at(-1)?.body_md).toContain('1 spend recommendation removed: STALE — Meta Ads spend');
    const repair = JSON.parse((await store.listMessages(thread.id))[4].apiJson) as { content: string };
    expect(repair.content).toContain('remove the 1 spend action(s): a data source is stale');
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
    expect(out.answer?.headline.text).toBe('Enrollments doubled to 8.');
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
