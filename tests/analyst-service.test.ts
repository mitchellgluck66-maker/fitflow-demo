/**
 * The Analyst service on PGlite (plan items 5–7): not configured → no brief →
 * the cap decision → a turn that runs to `done` with a fake stream → busy on a
 * concurrent turn → the orphan sweep opens an incident.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, syncIncidents, analystTurns } from '@/db';
import { setSetting } from '@/lib/settings';
import { ANTHROPIC_KEYS } from '@/lib/anthropic/config';
import { rebuildBrief } from '@/lib/analyst/briefService';
import { executeTurn, prepareTurn, resumeTurn, sweepAndRecord, ORPHAN_INCIDENT_KIND } from '@/lib/analyst/service';
import { DbAnalystStore } from '@/lib/analyst/store';
import type { AnalystClient } from '@/lib/analyst/run';
import type { BetaMessage } from '@/lib/analyst/api';
import type Anthropic from '@anthropic-ai/sdk';

const store = new DbAnalystStore();
const answer = JSON.stringify({ kind: 'answer', headline: { text: 'Nothing to report yet.', ref: '' }, sections: [{ key: 'what_happened', body_md: 'No data in the period.', numbers: [] }], actions: [], findings: [], note_proposals: [], clarifying_question: '' });
const finalMessage = { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 100 } } as unknown as BetaMessage;
const client: AnalystClient = {
  beta: {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
        },
        finalMessage: async () => finalMessage,
      }),
      create: async () => finalMessage,
    },
  },
};

beforeAll(async () => {
  await runMigrations();
});

describe('prepareTurn', () => {
  it('refuses without a key, then without a brief', async () => {
    expect(await prepareTurn({ clientTurnId: 'a', question: 'q', kind: 'ask' }, { store })).toMatchObject({ ok: false, status: 'not_configured', message: expect.stringContaining('Connect Anthropic in Setup') });
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test', { secret: true });
    expect(await prepareTurn({ clientTurnId: 'a', question: 'q', kind: 'ask' }, { store })).toMatchObject({ ok: false, status: 'no_brief', message: expect.stringContaining("hasn't been built yet") });
  });

  it('with a brief: estimates from a real token count, applies the caps, creates the thread and turn, and the loop runs to done', async () => {
    await rebuildBrief({ trigger: 'manual', countTokens: false });
    const big = await prepareTurn({ clientTurnId: 'big', question: 'Run everything', kind: 'report' }, { store, client, countTokens: async () => 2_000_000 });
    expect(big).toMatchObject({ ok: false, status: 'needs_confirmation', reason: expect.stringMatching(/^This run is estimated at \$\d+\.\d\d USD, above your \$3\.00 USD per-run cap$/) });
    expect(await store.liveTurn((big as { thread: { id: string } }).thread.id)).toBeNull(); // nothing was spent or started

    const ok = await prepareTurn({ clientTurnId: 't1', question: 'How did last week go?', kind: 'ask', context: { page: 'command_center', range: { start: '2026-09-20', end: '2026-09-26', label: 'Last week' } } }, { store, client, countTokens: async () => 20_000 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.thread.model).toBe('claude-opus-5-5');
    expect(ok.estimate.usd).toBeGreaterThan(0);
    expect(ok.estimate.usd).toBeLessThanOrEqual(3);
    expect(ok.allowedUsd).toBe(3);
    expect(ok.deps.userTurn).toContain('Viewing — page: command_center · range on screen: Last week (2026-09-20 – 2026-09-26)');
    expect(ok.deps.userTurn).toContain('Data health right now:');

    // A second turn on the same thread while this one is running is refused as busy.
    expect(await prepareTurn({ threadId: ok.thread.id, clientTurnId: 't2', question: 'x', kind: 'ask' }, { store, client, countTokens: async () => 1 })).toMatchObject({ ok: false, status: 'busy', message: 'This thread is answering' });
    // The same clientTurnId is idempotent.
    const again = await prepareTurn({ threadId: ok.thread.id, clientTurnId: 't1', question: 'How did last week go?', kind: 'ask' }, { store, client, countTokens: async () => 1 });
    expect(again).toMatchObject({ ok: true, created: false });

    const out = await executeTurn(ok.thread.id, ok.turn.id, ok.deps);
    expect(out.status).toBe('done');
    expect(out.answer?.headline.text).toBe('Nothing to report yet.');
    expect((await store.getTurn(ok.turn.id))?.costUsd).toBeCloseTo((500 * 4 + 100 * 20) / 1e6, 8);
    expect(await resumeTurn(ok.turn.id, { store, client })).toMatchObject({ ok: false, message: 'Turn is done' });
  });

  it('explain turns carry the glossary definition and the worked formula in the user turn', async () => {
    const r = await prepareTurn({ clientTurnId: 'e1', question: '', kind: 'explain', explainKey: 'paid_cac', context: { page: 'ads', range: { start: '2026-09-20', end: '2026-09-26' } } }, { store, client, countTokens: async () => 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deps.userTurn).toContain('Explain the metric "Paid CAC" (paid_cac) with kind "explain".');
    expect(r.deps.userTurn).toContain('Formula: spend ÷ paid-attributed enrollments');
    expect(r.deps.userTurn).toContain('Worked for the range on screen: Withheld: no spend in the period.');
    expect(await prepareTurn({ clientTurnId: 'e2', question: '', kind: 'explain', explainKey: 'nope' }, { store, client, countTokens: async () => 10 })).toMatchObject({ ok: false, status: 'error', message: 'Unknown metric "nope"' });
  });

  it('sweepAndRecord fails orphaned turns and opens one analyst_turn_failed incident each', async () => {
    const thread = await store.createThread({ model: 'claude-opus-5-5', effort: 'high', answerMode: 'format', briefHash: 'h' });
    const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'orphan', question: 'Why did consults drop?', kind: 'ask', pageContext: null });
    await db.update(analystTurns).set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) }).where(eq(analystTurns.id, turn.id));
    const swept = await sweepAndRecord(store);
    expect(swept.map((t) => t.id)).toContain(turn.id);
    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, ORPHAN_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
    expect(open.length).toBe(1);
    expect(open[0].message).toContain('the function stopped mid-round and nothing resumed it');
    expect(open[0].message).toContain('Why did consults drop?');
    await sweepAndRecord(store); // idempotent: still one
    expect((await db.select().from(syncIncidents).where(eq(syncIncidents.kind, ORPHAN_INCIDENT_KIND))).length).toBe(1);
  });
});
