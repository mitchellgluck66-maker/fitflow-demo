/**
 * Record / replay (tuning item 9): every fixture under tests/fixtures/analyst-replay/ is played through the REAL
 * loop on the in-memory store at $0 and must reproduce its recording — the verifier, repairs, display strings,
 * persistence and cost math. A fixture recorded by other code (contract, tools, answer schema, request shape)
 * fails with "fixtures stale: re-record". The harness itself is proven on a synthetic recording so the suite
 * means something before the first `npm run smoke:analyst -- --record`.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { analystWireHash, compareReplay, readFixtures, recordedToolResults, recordingClient, replayFixture, replayTools, STALE_MESSAGE, type RecordedTurn, type ReplayFixture } from '@/lib/analyst/replay';
import { runAnalystTurn, type AnalystClient, type AnalystEvent } from '@/lib/analyst/run';
import { MemoryAnalystStore } from '@/lib/analyst/store';
import { ANALYST_TOOLS, type AnalystTool, type Freshness } from '@/lib/analyst/tools';
import { ANALYST_CONTRACT } from '@/lib/analyst/prompts';
import type { BetaMessage } from '@/lib/analyst/api';

const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
const msg = (content: unknown[], stop = 'end_turn', usage: Record<string, number> = {}): BetaMessage =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } }) as unknown as BetaMessage;
const answer = (headline: string, ref: string) => JSON.stringify({ kind: 'answer', headline: { text: headline, ref }, sections: [{ key: 'what_happened', body_md: 'Spend was **$3,697.68 CAD**.', numbers: [{ text: '$3,697.68 CAD', ref: 'r1:data.marketing.spendCents' }] }], actions: [], findings: [], note_proposals: [], clarifying_question: '' });

/** A "live" client scripted for the recording pass: one tool round, a wrong answer, a repaired one. */
function scriptedLive(script: BetaMessage[]): AnalystClient {
  const queue = [...script];
  return { beta: { messages: { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent; }, finalMessage: async () => { const n = queue.shift(); if (!n) throw new Error('script exhausted'); return n; } }), create: async () => { throw new Error('no compaction'); } } } };
}

/** Record one turn the way the smoke does: real tool definitions with a stub run, the recorder around the client. */
async function recordSynthetic(): Promise<ReplayFixture> {
  const store = new MemoryAnalystStore();
  const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
  const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'rec-1', question: 'How did we do?', kind: 'ask', pageContext: null });
  const tools: AnalystTool[] = ANALYST_TOOLS.map((t) => ({ ...t, run: async () => ({ range: null, currency: 'CAD', fx: '', data: { marketing: { spendCents: 369_768, enrollments: 8 } } }) }));
  const live = recordingClient(
    scriptedLive([
      msg([{ type: 'tool_use', id: 'tu1', name: 'get_scorecard', input: { range: { preset: 'last_week', start: '', end: '' }, compare: 'previous_period' } }], 'tool_use', { cache_creation_input_tokens: 900 }),
      msg([{ type: 'text', text: answer('Spend was $3,700 CAD.', 'r1:data.marketing.spendCents') }], 'end_turn', { cache_read_input_tokens: 900 }), // $3,700 ≠ $3,697.68 → repair
      msg([{ type: 'text', text: answer('Spend was $3,697.68 CAD.', 'r1:data.marketing.spendCents') }], 'end_turn', { cache_read_input_tokens: 1200 }),
    ]),
  );
  const events: AnalystEvent[] = [];
  const out = await runAnalystTurn(thread.id, turn.id, { store, client: live, contract: ANALYST_CONTRACT, brief: { text: 'BRIEF', hash: 'h' }, tools, freshness, userTurn: 'Today: 2026-09-30.\nHow did we do?', allowedUsd: 3, retryDelayMs: 1, onEvent: (e) => events.push(e) });
  expect(out.status).toBe('done');
  const rows = (await store.listMessages(thread.id)).map((r) => ({ role: r.role, apiJson: r.apiJson, display: r.display }));
  const recorded: RecordedTurn = {
    question: 'How did we do?',
    kind: 'ask',
    userTurn: 'Today: 2026-09-30.\nHow did we do?',
    freshness,
    responses: live.responses,
    compactions: live.compactions,
    rows,
    outcome: { status: out.status, headline: out.answer?.headline.text ?? null, flagged: out.flagged, repairs: events.filter((e) => e.type === 'status' && e.text === 'Repairing the answer…').length, rounds: out.rounds, costUsd: out.costUsd, usage: out.usage, sections: out.answer?.sections.map((s) => s.key) ?? [], proposals: [] },
  };
  return { version: 1, recordedAt: '2026-09-30T00:00:00.000Z', wireHash: analystWireHash('format'), model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', database: 'synthetic', turns: [recorded] };
}

describe('the harness (synthetic recording)', () => {
  it('a recorded turn replays through the real loop with the same outcome, repairs, cost and byte-identical log rows', async () => {
    const fixture = await recordSynthetic();
    expect(fixture.turns[0].outcome).toMatchObject({ status: 'done', headline: 'Spend was $3,697.68 CAD.', repairs: 1, rounds: 2 });
    expect(recordedToolResults(fixture).get('r1')?.data).toMatchObject({ marketing: { spendCents: 369_768, spendCentsText: '$3,697.68 CAD' } });
    const [replayed] = await replayFixture(fixture);
    expect(compareReplay(fixture.turns[0], replayed)).toEqual([]);
    expect(replayed.outcome.costUsd).toBeCloseTo(fixture.turns[0].outcome.costUsd, 8);
    expect(replayed.repairs).toBe(1);
  });
  it('a tampered recording is caught: a changed usage changes the cost; a missing response is a divergence; an unknown ref is an error result', async () => {
    const fixture = await recordSynthetic();
    const tampered: ReplayFixture = JSON.parse(JSON.stringify(fixture));
    (tampered.turns[0].responses[2].usage as { output_tokens: number }).output_tokens = 9_000;
    const [r] = await replayFixture(tampered);
    expect(compareReplay(tampered.turns[0], r)).toEqual([expect.stringMatching(/^cost .* ≠ recorded /)]); // usage is not in the log rows; the cost math catches it
    const short: ReplayFixture = JSON.parse(JSON.stringify(fixture));
    short.turns[0].responses.pop();
    const [s] = await replayFixture(short);
    expect(s.outcome.status).toBe('failed');
    expect(s.outcome.error).toMatch(/the loop diverged from the recording/);
    const tool = replayTools(new Map()).find((t) => t.definition.name === 'get_scorecard')!;
    expect(await tool.run({}, { ref: 'r9', freshness, resolveRef: () => undefined })).toMatchObject({ data: null, error: expect.stringMatching(/no recorded result for r9/) });
  });
  it('the wire hash moves with the contract, the tools, the answer schema and the request shape', () => {
    expect(analystWireHash('format')).toMatch(/^[0-9a-f]{64}$/);
    expect(analystWireHash('format')).not.toBe(analystWireHash('submit_answer'));
    expect(STALE_MESSAGE).toBe('fixtures stale: re-record (npm run smoke:analyst -- --record)');
  });
});

const fixtures = readFixtures();

describe('recorded fixtures (tests/fixtures/analyst-replay/)', () => {
  it(`${fixtures.length} fixture(s) found${fixtures.length ? '' : ' — none recorded yet: npm run smoke:analyst -- --record'}`, () => {
    expect(Array.isArray(fixtures)).toBe(true);
  });
  for (const { name, fixture } of fixtures) {
    it(`${name}: recorded by the current wire contract (else "${STALE_MESSAGE}")`, () => {
      expect(fixture.wireHash, STALE_MESSAGE).toBe(analystWireHash(fixture.answerMode));
    });
    it(`${name}: ${fixture.turns.length} turn(s) replay faithfully`, async () => {
      if (fixture.wireHash !== analystWireHash(fixture.answerMode)) return; // reported above
      const replayed = await replayFixture(fixture);
      replayed.forEach((r, i) => expect(compareReplay(fixture.turns[i], r), `turn ${i + 1}`).toEqual([]));
    }, 60_000);
  }
});
