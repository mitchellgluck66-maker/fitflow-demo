/**
 * The panel's pure parts (Wave 2 item 4b): the event fold (idempotent on the SSE index; sections stream then the
 * answer replaces them; continue / confirmation / error / stop / done), a stored thread folded into the same views,
 * the thinking sub-line labels, the usage line, and the word-fade plugin.
 */
import { describe, it, expect } from 'vitest';
import { applyEvent, applyEvents, currentStatus, greeting, newTurnView, toolStatusLine, turnsFromTranscript, usageLine, type ThreadTranscript } from '@/lib/analyst/clientState';
import type { AnalystEvent } from '@/lib/analyst/run';
import type { RenderedAnswer } from '@/lib/analyst/render';
import { fadeWords, type HastNode } from '@/components/analyst/wordFade';

const rendered: RenderedAnswer = {
  kind: 'answer',
  headline: 'A weak week.',
  sections: [
    { key: 'what_happened', body_md: '**2** new paying clients.' },
    { key: 'do_this', body_md: 'Hold spend.' },
  ],
  actions: [{ action: 'Hold account: 12 of 4', why: 'w', owner: 'Owner', kind: 'spend', campaign: 'account', spend_change: 'hold', expected_impact: 'none while the gate holds', confidence: 'high', metric: 'spend_gate', check_date: '2026-10-22', gate: 'hold', decidedBy: 'server' }],
  findings: [],
  note_proposals: ['2026-10-15: cap Meta at $4,000 CAD'],
  clarifying_question: '',
};
const usage = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 30_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 5_000 };
const e = (x: Record<string, unknown>) => x as unknown as AnalystEvent;

describe('applyEvent', () => {
  it('folds a turn\'s events in order: notice → statuses → streamed sections → the answer replaces them → usage → done; an index already folded is ignored', () => {
    let t = newTurnView({ clientTurnId: 'c1', question: 'How did we do?', kind: 'ask' });
    expect(t.status).toBe('starting');
    t = applyEvent(t, e({ type: 'tools', calls: [{ ref: 'r1', name: 'get_data_health', label: 'Snapshot: get_data_health' }, { ref: 'r2', name: 'get_scorecard', label: 'x' }] }), 1);
    t = applyEvent(t, e({ type: 'notice', text: 'data fresh — oldest 12 min ago', stale: false }), 2);
    t = applyEvent(t, e({ type: 'status', text: 'Comparing to the baseline' }), 3);
    t = applyEvent(t, e({ type: 'section', key: 'what_happened', verified: true, seconds: 12.1, index: 0, body_md: '**2** new paying clients.' }), 4);
    expect(t.status).toBe('running');
    expect(t.notice).toEqual({ text: 'data fresh — oldest 12 min ago', stale: false });
    expect(t.statuses).toEqual(['Checking data freshness and reading the scorecard', 'Comparing to the baseline']);
    expect(currentStatus(t)).toBe('Comparing to the baseline');
    expect(t.sections).toEqual([{ index: 0, key: 'what_happened', body_md: '**2** new paying clients.', verified: true }]);
    // A replayed section (same index) replaces, never duplicates; a stale index is ignored entirely.
    expect(applyEvent(t, e({ type: 'section', key: 'what_happened', verified: true, seconds: 12.1, index: 0, body_md: 'again' }), 5).sections).toHaveLength(1);
    expect(applyEvent(t, e({ type: 'status', text: 'old' }), 3)).toBe(t);
    t = applyEvent(t, e({ type: 'section', key: 'do_this', verified: false, seconds: 20, index: 1, body_md: '[no source] spend' }), 5);
    expect(t.sections.map((s) => [s.key, s.verified])).toEqual([['what_happened', true], ['do_this', false]]);
    t = applyEvent(t, e({ type: 'answer', answer: {}, rendered, flagged: [], repaired: true, repairs: 1, strippedSpendActions: 0, spendDecisions: [{ campaign: 'account', gate: 'hold', basis: 'b', decision: 'hold', decidedBy: 'server', ref: 'r2:data.spendGates.account.decision' }], firstSectionSeconds: 12.1 }), 6);
    expect(t.answer).toBe(rendered);
    expect(t.sections.map((s) => [s.key, s.verified])).toEqual([['what_happened', true], ['do_this', true]]); // the final render wins
    expect(t.spendDecisions).toHaveLength(1);
    expect(t.repaired).toBe(true);
    t = applyEvent(t, e({ type: 'usage', usage, costUsd: 0.34, model: 'claude-opus-5-5', rounds: 1, estimated: false, split: null }), 7);
    expect(t.usage).toEqual({ inputTokens: 36_000, outputTokens: 500, costUsd: 0.34, model: 'claude-opus-5-5' });
    expect(usageLine(t.usage!)).toBe('36.0K in · 500 out · $0.34 USD');
    t = applyEvent(t, e({ type: 'done', status: 'done' }), 8);
    expect(t.status).toBe('done');
    expect(t.lastEventIndex).toBe(8);
  });

  it('continue, a cost pause, an error, a stop and the explain event each set the state the panel renders', () => {
    const base = newTurnView({ clientTurnId: 'c', question: 'q', kind: 'explain' });
    expect(applyEvent(base, e({ type: 'continue' }), 1).status).toBe('continue');
    const paused = applyEvent(base, e({ type: 'needs_confirmation', reason: 'This run would pass $3.00 USD', spentUsd: 2.1 }), 1);
    expect(paused.status).toBe('needs_confirmation');
    expect(paused.confirmation).toEqual({ reason: 'This run would pass $3.00 USD', spentUsd: 2.1, estimateUsd: null });
    const failed = applyEvent(base, e({ type: 'error', message: 'Analyst request failed: Anthropic 529 · overloaded', retryable: true }), 1);
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ message: 'Analyst request failed: Anthropic 529 · overloaded', retryable: true });
    expect(applyEvents(base, [{ event: e({ type: 'stopped' }), index: 1 }, { event: e({ type: 'done', status: 'stopped' }), index: 2 }]).status).toBe('stopped');
    const explained = applyEvent(base, e({ type: 'explain', key: 'paid_cac', label: 'Paid CAC', definition: 'd', differsFrom: 'x', formula: 'spend ÷ paid enrollments', worked: '$9,890.33 CAD ÷ 6 = $1,648.39 CAD', value: 164_839, reason: null, maturing: false }), 1);
    expect(explained.explain).toEqual({ key: 'paid_cac', label: 'Paid CAC', definition: 'd', differsFrom: 'x', formula: 'spend ÷ paid enrollments', worked: '$9,890.33 CAD ÷ 6 = $1,648.39 CAD', value: 164_839, reason: null, maturing: false });
    expect(applyEvent(base, e({ type: 'repair', problems: [], targeted: true, paths: [] }), 1).statuses).toEqual(['Checking the numbers']);
  });

  it('tool labels read as the owner would say them', () => {
    expect(toolStatusLine([{ name: 'get_campaigns' }])).toBe('Reading campaign data');
    expect(toolStatusLine([{ name: 'get_funnel' }, { name: 'get_stage_people' }])).toBe('Reading the funnel and listing the people in a stage');
    expect(toolStatusLine([{ name: 'get_funnel' }, { name: 'get_campaigns' }, { name: 'calculate' }])).toBe('Reading the funnel and 2 more reads');
    expect(toolStatusLine([{ name: 'something_new' }])).toBe('Running something_new');
    expect(toolStatusLine([])).toBe('Thinking');
    expect(greeting(9)).toBe('Good morning.');
    expect(greeting(15)).toBe('Good afternoon.');
    expect(greeting(21)).toBe('Good evening.');
  });
});

describe('turnsFromTranscript', () => {
  it('a stored thread folds into the same views: the question and explain from the user row, the rendered answer from the assistant row, usage from the turn; a running turn resumes from its events', () => {
    const t: ThreadTranscript = {
      thread: { id: 'th', title: 'How did we do?', model: 'claude-opus-5-5' },
      turns: [
        { id: 't1', status: 'done', question: 'How did we do?', kind: 'ask', costUsd: 0.34, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 30_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 5_000 }, error: null, events: [] },
        { id: 't2', status: 'failed', question: 'And spend?', kind: 'ask', costUsd: 0, usage: null, error: 'Analyst request failed: x', events: [] },
        { id: 't3', status: 'running', question: 'What does Paid CAC mean?', kind: 'explain', costUsd: null, usage: null, error: null, events: [e({ type: 'notice', text: 'fresh', stale: false }), e({ type: 'explain', key: 'paid_cac', label: 'Paid CAC', definition: 'd', differsFrom: 'x', formula: 'f', worked: 'w', value: 1, reason: null, maturing: false }), e({ type: 'status', text: 'Reading the definition' })] },
      ],
      transcript: [
        { seq: 1, turnId: 't1', role: 'tool_results', display: { starter: true, question: 'How did we do?' } },
        { seq: 2, turnId: 't1', role: 'assistant', display: { answer: {}, rendered, flagged: [], repaired: false, spendDecisions: [] } },
        { seq: 3, turnId: 't2', role: 'user', display: { question: 'And spend?' } },
        { seq: 4, turnId: 't3', role: 'user', display: { question: 'What does Paid CAC mean?', explain: { key: 'paid_cac', label: 'Paid CAC', definition: 'd', differsFrom: 'x', formula: 'f', worked: 'w', value: 1, reason: null, maturing: false } } },
      ],
    };
    const views = turnsFromTranscript(t);
    expect(views.map((v) => [v.id, v.status, v.kind])).toEqual([['t1', 'done', 'ask'], ['t2', 'failed', 'ask'], ['t3', 'running', 'explain']]);
    expect(views[0].answer).toEqual(rendered);
    expect(views[0].sections.map((s) => s.key)).toEqual(['what_happened', 'do_this']);
    expect(views[0].usage).toEqual({ inputTokens: 36_000, outputTokens: 500, costUsd: 0.34, model: 'claude-opus-5-5' });
    expect(views[1].error).toEqual({ message: 'Analyst request failed: x', retryable: true });
    expect(views[2].explain?.key).toBe('paid_cac');
    expect(views[2].statuses).toEqual(['Reading the definition']);
    expect(views[2].lastEventIndex).toBe(3); // the reconnect replays from here
  });
});

describe('wordFade', () => {
  it('wraps every word outside code in a staggered span and leaves whitespace and code alone', () => {
    const tree: HastNode = { type: 'root', children: [{ type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Hello  big world' }, { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'keep me' }] }] }] };
    const n = fadeWords(tree, { stepMs: 10 });
    expect(n).toBe(3);
    const p = tree.children![0];
    expect(p.children!.map((c) => (c.type === 'text' ? c.value : `${c.tagName}:${(c.properties?.style as string | undefined) ?? ''}`))).toEqual(['span:animation-delay:0ms', '  ', 'span:animation-delay:10ms', ' ', 'span:animation-delay:20ms', 'code:']);
    expect(p.children![5].children![0]).toEqual({ type: 'text', value: 'keep me' });
    // The delay is capped so a long answer never waits seconds for its last word.
    const long: HastNode = { type: 'root', children: [{ type: 'text', value: Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ') }] };
    fadeWords(long, { stepMs: 18, maxDelayMs: 2_600 });
    expect(long.children![long.children!.length - 1].properties?.style).toBe('animation-delay:2600ms');
  });
});
