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
import { addNote, decideNote, listNotes, saveProposals } from '@/lib/analyst/notes';
import { runAnalystTool } from '@/lib/analyst/tools';
import { SNAPSHOT_PREFIX, STARTER_INSTRUCTION } from '@/lib/analyst/starter';
import { executeTurn, prepareTurn, resumeTurn, sweepAndRecord, ORPHAN_INCIDENT_KIND } from '@/lib/analyst/service';
import { DbAnalystStore } from '@/lib/analyst/store';
import type { AnalystClient, AnalystEvent } from '@/lib/analyst/run';
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

    const counted: Array<{ messages: Array<{ role: string }> }> = [];
    const ok = await prepareTurn({ clientTurnId: 't1', question: 'How did last week go?', kind: 'ask', context: { page: 'command_center', range: { start: '2026-09-20', end: '2026-09-26', label: 'Last week' } } }, { store, client, countTokens: async (p) => { counted.push(p as unknown as { messages: Array<{ role: string }> }); return 20_000; } });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.thread.model).toBe('claude-opus-5-5');
    expect(ok.thread.effort).toBe('medium'); // a chat thread; fixed for the thread's life
    expect((big as { thread: { effort: string } }).thread.effort).toBe('high'); // a report thread keeps the Setup effort
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

    // Item 4: a NEW thread opens with the server-fetched snapshot — the count saw it, the deps carry it (ONE user message).
    expect(counted.at(-1)?.messages.map((m) => m.role)).toEqual(['user']);
    expect(ok.deps.starterRows?.map((r) => r.role)).toEqual(['tool_results']);
    expect(ok.deps.starterRows?.every((r) => r.turnId === ok.turn.id)).toBe(true);

    const out = await executeTurn(ok.thread.id, ok.turn.id, ok.deps);
    expect(out.status).toBe('done');
    expect(out.answer?.headline.text).toBe('Nothing to report yet.');
    const rows = await store.listMessages(ok.thread.id);
    expect(rows.map((r) => r.role)).toEqual(['tool_results', 'assistant']);
    const snapshot = JSON.parse(rows[0].apiJson) as { role: string; content: Array<{ type: string; text: string }> };
    expect(snapshot.role).toBe('user');
    expect(snapshot.content.map((c) => c.type)).toEqual(['text', 'text', 'text', 'text']);
    expect(snapshot.content[0].text).toBe(STARTER_INSTRUCTION);
    expect(snapshot.content[3].text).toBe(ok.deps.userTurn);
    expect(snapshot.content[1].text.startsWith(SNAPSHOT_PREFIX)).toBe(true);
    const r1 = JSON.parse(snapshot.content[1].text.slice(SNAPSHOT_PREFIX.length)) as { ref: string; data: unknown; error?: string };
    const r2 = JSON.parse(snapshot.content[2].text.slice(SNAPSHOT_PREFIX.length)) as { ref: string; data: { kpis: unknown; baseline: { conversions: unknown[] } }; error?: string };
    expect([r1.ref, r2.ref]).toEqual(['r1', 'r2']);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r2.data.kpis).toBeDefined();
    expect(Array.isArray(r2.data.baseline.conversions)).toBe(true);
    const { ledgerFromLog } = await import('@/lib/analyst/run');
    expect(ledgerFromLog(rows).calls).toBe(2); // the next live call is r3
    expect(ledgerFromLog(rows).ledger.get('r2:data.marketing.spendCents')).toBeDefined();
    // A follow-up turn on the same thread gets NO second snapshot.
    const t3 = await prepareTurn({ threadId: ok.thread.id, clientTurnId: 't3', question: 'And the week before?', kind: 'ask' }, { store, client, countTokens: async () => 1 });
    expect(t3).toMatchObject({ ok: true, deps: { starterRows: null } });
    // Item 5: the first turn stored its estimate beside its measured cost, and the next estimate of the kind is
    // calibrated from it (actual ÷ estimate, clamped to ≥ 0.5 here because the fake stream cost almost nothing).
    expect((await store.getTurn(ok.turn.id))?.estimateUsd).toBe(ok.estimate.usd);
    expect(await store.recentEstimates('ask', 20)).toEqual([{ estimateUsd: ok.estimate.usd, costUsd: (await store.getTurn(ok.turn.id))!.costUsd }]);
    if (t3.ok) {
      expect(t3.estimate.detail).toContain('calibrated ×0.5 on 1 run');
      expect(t3.estimate.calibration).toBe(0.5);
    }
    expect((await store.getTurn(ok.turn.id))?.costUsd).toBeCloseTo((500 * 4 + 100 * 20) / 1e6, 8);
    expect(await resumeTurn(ok.turn.id, { store, client })).toMatchObject({ ok: false, message: 'Turn is done' });
  });

  it('item 6 memory: a finished answer\'s note_proposals become PROPOSED notes (deduped); approval puts the note in the next turn\'s brief and in get_notes', async () => {
    const fact = '2026-09-30: Meta spend capped at $4,000 CAD a month from October';
    const withProposal = JSON.stringify({ kind: 'answer', headline: { text: 'Noted.', ref: '' }, sections: [{ key: 'what_happened', body_md: 'Understood.', numbers: [] }], actions: [], findings: [], note_proposals: [fact, `${fact}.`, 'Price rose to $5,000 on Aug 1'], clarifying_question: '' });
    const proposing: AnalystClient = { beta: { messages: { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent; }, finalMessage: async () => ({ ...finalMessage, content: [{ type: 'text', text: withProposal }] }) as BetaMessage }), create: async () => finalMessage } } };
    await addNote('Price rose to $5,000 on Aug 1', { source: 'owner' }); // already known → skipped
    const events: AnalystEvent[] = [];
    const p = await prepareTurn({ clientTurnId: 'mem-1', question: 'For the record: from October we cap Meta spend at $4,000 CAD a month.', kind: 'ask' }, { store, client: proposing, countTokens: async () => 10, onEvent: (e) => events.push(e) });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = await executeTurn(p.thread.id, p.turn.id, p.deps);
    expect(out.status).toBe('done');
    expect(out.answer?.note_proposals).toEqual([fact, `${fact}.`, 'Price rose to $5,000 on Aug 1']);
    expect(events.find((e) => e.type === 'status' && e.text.includes('note proposal'))).toMatchObject({ text: '1 note proposal saved for your approval (Setup → Analyst → Notes) · 2 already known.' });
    const proposed = (await listNotes('proposed')).filter((n) => n.threadId === p.thread.id);
    expect(proposed.map((n) => [n.text, n.source])).toEqual([[fact, 'analyst']]);
    // Not yet in any prompt.
    await rebuildBrief({ trigger: 'notes', countTokens: false });
    const before = await prepareTurn({ threadId: p.thread.id, clientTurnId: 'mem-2', question: 'What is our Meta cap?', kind: 'ask' }, { store, client, countTokens: async () => 10 });
    expect(before.ok && before.deps.brief.text.includes('$4,000 CAD')).toBe(false);
    expect(JSON.stringify((await runAnalystTool('get_notes', {}, { ref: 'r1', freshness: { stale: false, line: 'ok', sources: [] }, resolveRef: () => undefined })).data)).not.toContain('$4,000');
    // The owner approves → the brief is rebuilt (as the notes route does) → the next turn's prompt and get_notes carry it.
    expect(await decideNote(proposed[0].id, 'active')).toMatchObject({ status: 'active' });
    await rebuildBrief({ trigger: 'notes', countTokens: false });
    if (before.ok) await executeTurn(before.thread.id, before.turn.id, before.deps);
    const after = await prepareTurn({ threadId: p.thread.id, clientTurnId: 'mem-3', question: 'What is our Meta cap?', kind: 'ask' }, { store, client, countTokens: async () => 10 });
    expect(after.ok && after.deps.brief.text).toContain(fact);
    const notes = (await runAnalystTool('get_notes', {}, { ref: 'r1', freshness: { stale: false, line: 'ok', sources: [] }, resolveRef: () => undefined })).data as { notes: Array<{ text: string }> };
    expect(notes.notes.map((n) => n.text)).toContain(fact);
    // A second proposal of the same fact (now active) is skipped, not duplicated.
    expect(await saveProposals([fact.toUpperCase()], { threadId: p.thread.id })).toMatchObject({ saved: [], skipped: 1 });
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
