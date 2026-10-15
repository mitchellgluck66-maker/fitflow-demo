/**
 * Panel preview states for the screenshot harness (Wave 2 item 8) — PURE. Built from the demo-tenant replay fixture
 * (tests/fixtures/analyst-replay/turn-1.json: a real recorded answer, rendered by the server) into the panel's own
 * TurnView shape, so every captured state — welcome, thinking, answer, explain, error, threads, cost confirmation —
 * renders through the real components at $0 and looks like a real conversation. Served by GET /api/analyst/preview,
 * which exists ONLY when the server runs with ANALYST_PREVIEW=1 outside production.
 */

import type { TurnView } from './clientState';
import { newTurnView } from './clientState';
import type { RenderedAnswer } from './render';
import type { SpendDecision } from './spendDecisions';
import type { ExplainInfo } from './prompts';

export const PREVIEW_STATES = ['welcome', 'thinking', 'answer', 'explain', 'error', 'threads', 'confirm'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export interface PreviewPayload {
  state: PreviewState;
  open: boolean;
  view: 'chat' | 'threads';
  turns: TurnView[];
  threads: Array<{ id: string; title: string | null; model: string; createdAt: string; lastTurnAt: string | null }>;
  freshness: { stale: boolean; text: string };
}

interface FixtureLike {
  model: string;
  turns: Array<{ question: string; rows: Array<{ role: string; display: Record<string, unknown> | null }>; outcome: { costUsd: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number } } }>;
}

/** The recorded answer of the fixture's first turn (the assistant row with `rendered`). */
export function recordedAnswer(fixture: FixtureLike): { question: string; rendered: RenderedAnswer; spendDecisions: SpendDecision[]; usage: TurnView['usage'] } | null {
  const t = fixture.turns[0];
  if (!t) return null;
  const row = [...t.rows].reverse().find((r) => r.role === 'assistant' && r.display && 'rendered' in r.display);
  if (!row?.display) return null;
  const d = row.display as { rendered: RenderedAnswer; spendDecisions?: SpendDecision[] };
  const u = t.outcome.usage;
  return { question: t.question, rendered: d.rendered, spendDecisions: d.spendDecisions ?? [], usage: { inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens, outputTokens: u.outputTokens, costUsd: t.outcome.costUsd, model: fixture.model } };
}

const EXPLAIN_SAMPLE: ExplainInfo = {
  key: 'paid_cac',
  label: 'Paid CAC',
  definition: 'What it costs in ads to win one new client who came from those ads. Blended CAC spreads the same spend over every new client, organic included, so it always reads lower.',
  differsFrom: 'Blended CAC counts organic clients in the denominator; cost per client on the campaign table is per campaign.',
  formula: 'Meta ad spend ÷ enrollments whose lead is classed paid',
  worked: '$9,890.33 CAD ÷ 6 paid enrollments = $1,648.39 CAD',
  value: 164_839,
  reason: null,
  maturing: false,
};

export function previewPayload(state: PreviewState, fixture: FixtureLike | null, now = new Date('2026-10-15T15:00:00.000Z')): PreviewPayload {
  const rec = fixture ? recordedAnswer(fixture) : null;
  const fresh = { stale: false, text: 'data fresh 12 min ago' };
  const base = (over: Partial<TurnView>): TurnView => ({ ...newTurnView({ clientTurnId: 'preview-1', question: rec?.question ?? 'How did last week go, and what should we focus on this week?', kind: 'ask', id: 'preview-turn' }), notice: { text: 'data fresh — oldest connected source completed 12 min ago', stale: false }, ...over });
  const threads = [
    { id: 'preview-a', title: rec?.question ?? 'How did last week go, and what should we focus on this week?', model: fixture?.model ?? 'claude-opus-5-5', createdAt: new Date(now.getTime() - 3_600_000).toISOString(), lastTurnAt: new Date(now.getTime() - 1_800_000).toISOString() },
    { id: 'preview-b', title: 'Which campaigns should we scale or cut?', model: fixture?.model ?? 'claude-opus-5-5', createdAt: new Date(now.getTime() - 86_400_000).toISOString(), lastTurnAt: new Date(now.getTime() - 80_000_000).toISOString() },
    { id: 'preview-c', title: 'What does Paid CAC mean?', model: fixture?.model ?? 'claude-opus-5-5', createdAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(), lastTurnAt: null },
  ];
  switch (state) {
    case 'welcome':
      return { state, open: true, view: 'chat', turns: [], threads: [], freshness: fresh };
    case 'thinking':
      return { state, open: true, view: 'chat', turns: [base({ status: 'running', statuses: ['Reading the scorecard', 'Comparing to your 8-week baseline'] })], threads: [], freshness: fresh };
    case 'answer':
      return { state, open: true, view: 'chat', turns: [base({ status: 'done', answer: rec?.rendered ?? null, spendDecisions: rec?.spendDecisions ?? [], sections: (rec?.rendered.sections ?? []).map((s, i) => ({ index: i, key: s.key, body_md: s.body_md, verified: true })), usage: rec?.usage ?? { inputTokens: 36_700, outputTokens: 2_400, costUsd: 0.34, model: 'claude-opus-5-5' } })], threads: [], freshness: fresh };
    case 'explain': {
      const sections: RenderedAnswer['sections'] = [
        { key: 'what_it_is', body_md: '**Paid CAC** is what it costs in ads to win one new client who came from those ads. Blended CAC spreads the same spend over *every* new client, organic included, so it always reads lower.' },
        { key: 'what_yours_says', body_md: 'Each paid client cost about **$1,648.39 CAD** in August, 12% cheaper than July and below your 3-month average. Six clients is a small sample, so read this as a signal, not yet a trend.' },
        { key: 'what_to_do', body_md: '**No action needed; flag it if Paid CAC crosses $2,000 CAD.** Put any extra budget on the campaign whose gate says may change, not on one at hold.' },
      ];
      const rendered: RenderedAnswer = { kind: 'explain', headline: 'Paid CAC was $1,648.39 CAD last month — below your 3-month average.', sections, actions: [], findings: [], note_proposals: [], clarifying_question: '' };
      return { state, open: true, view: 'chat', turns: [base({ clientTurnId: 'preview-explain', question: 'What does Paid CAC mean?', kind: 'explain', status: 'done', explain: EXPLAIN_SAMPLE, answer: rendered, sections: sections.map((s, i) => ({ index: i, key: s.key, body_md: s.body_md, verified: true })), usage: { inputTokens: 38_200, outputTokens: 1_100, costUsd: 0.21, model: fixture?.model ?? 'claude-opus-5-5' } })], threads: [], freshness: fresh };
    }
    case 'error':
      return { state, open: true, view: 'chat', turns: [base({ status: 'failed', error: { message: 'Analyst request failed: Anthropic 529 · overloaded_error: Overloaded (request_id req_preview)', retryable: true } })], threads: [], freshness: fresh };
    case 'threads':
      return { state, open: true, view: 'threads', turns: [], threads, freshness: fresh };
    case 'confirm':
      return { state, open: true, view: 'chat', turns: [base({ id: null, status: 'needs_confirmation', confirmation: { reason: 'This run is estimated at $4.10 USD, above your $3.00 USD cap', spentUsd: null, estimateUsd: 4.1 } })], threads: [], freshness: fresh };
    default:
      return { state: 'welcome', open: true, view: 'chat', turns: [], threads: [], freshness: fresh };
  }
}
