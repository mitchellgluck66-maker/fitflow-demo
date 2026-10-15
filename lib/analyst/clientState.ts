/**
 * The panel's state machine (Wave 2 item 4b, 2026-10-15) — PURE, client-safe. Progress events (`AnalystEvent`, the
 * same objects the SSE route replays) fold into one `TurnView` per turn; a thread's transcript (GET
 * /api/analyst/threads/[id]) folds into the same shape, so history and a live turn render through one component.
 * Reconnection replays from `lastEventIndex` (the SSE `id`); every fold is idempotent on the index.
 */

import type { AnalystEvent } from './run';
import type { RenderedAnswer } from './render';
import type { SpendDecision } from './spendDecisions';
import type { ExplainInfo } from './prompts';

export type TurnViewStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'continue';

export interface SectionView {
  index: number;
  key: string;
  body_md: string;
  verified: boolean;
}

export interface TurnView {
  id: string | null;
  clientTurnId: string;
  question: string;
  kind: 'ask' | 'explain' | 'report';
  status: TurnViewStatus;
  notice: { text: string; stale: boolean } | null;
  explain: ExplainInfo | null;
  /** The live status line (the latest `status` / tool label) and the ones before it. */
  statuses: string[];
  /** Sections streamed so far (replaced by the final answer's sections when it arrives). */
  sections: SectionView[];
  answer: RenderedAnswer | null;
  spendDecisions: SpendDecision[];
  flagged: number;
  repaired: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; model: string | null } | null;
  error: { message: string; retryable: boolean } | null;
  confirmation: { reason: string; spentUsd: number | null; estimateUsd: number | null } | null;
  /** The SSE index of the last event folded in (the `after` for a reconnect). */
  lastEventIndex: number;
}

export function newTurnView(p: { clientTurnId: string; question: string; kind: TurnView['kind']; id?: string | null }): TurnView {
  return { id: p.id ?? null, clientTurnId: p.clientTurnId, question: p.question, kind: p.kind, status: 'starting', notice: null, explain: null, statuses: [], sections: [], answer: null, spendDecisions: [], flagged: 0, repaired: false, usage: null, error: null, confirmation: null, lastEventIndex: 0 };
}

/** Human labels for the thinking sub-line, per tool. */
export const TOOL_LABELS: Record<string, string> = {
  get_scorecard: 'Reading the scorecard',
  get_data_health: 'Checking data freshness',
  get_funnel: 'Reading the funnel',
  get_stage_people: 'Listing the people in a stage',
  get_campaigns: 'Reading campaign data',
  get_revenue: 'Reading revenue and cash',
  get_trend: 'Reading the trend',
  list_clients: 'Listing clients',
  get_client: 'Opening a client',
  get_payments: 'Reading payments',
  compare_periods: 'Comparing periods',
  get_notes: 'Reading your notes',
  get_metric: 'Reading the definition',
  get_todo: 'Reading who to call today',
  calculate: 'Doing the arithmetic',
};

export function toolStatusLine(calls: ReadonlyArray<{ name: string; label?: string }>): string {
  const names = [...new Set(calls.map((c) => c.name))];
  if (names.length === 0) return 'Thinking';
  if (names.length === 1) return TOOL_LABELS[names[0]] ?? `Running ${names[0]}`;
  const [first, ...rest] = names.map((n) => TOOL_LABELS[n] ?? n);
  return `${first} and ${rest.length === 1 ? rest[0].charAt(0).toLowerCase() + rest[0].slice(1) : `${rest.length} more reads`}`;
}

/** Fold one event (its 1-based SSE index) into a turn view. Idempotent: an index already folded is ignored. */
export function applyEvent(turn: TurnView, event: AnalystEvent, index: number): TurnView {
  if (index <= turn.lastEventIndex) return turn;
  const t: TurnView = { ...turn, lastEventIndex: index, status: turn.status === 'starting' ? 'running' : turn.status };
  switch (event.type) {
    case 'notice':
      return { ...t, notice: { text: event.text, stale: event.stale } };
    case 'explain': {
      const { type: _type, ...info } = event;
      return { ...t, explain: info };
    }
    case 'status':
      return { ...t, statuses: [...t.statuses, event.text] };
    case 'tools':
      return event.calls.length ? { ...t, statuses: [...t.statuses, toolStatusLine(event.calls)] } : t;
    case 'repair':
      return { ...t, statuses: [...t.statuses, 'Checking the numbers'], repaired: true };
    case 'section': {
      const sections = t.sections.filter((s) => s.index !== event.index);
      sections.push({ index: event.index, key: event.key, body_md: event.body_md, verified: event.verified });
      sections.sort((a, b) => a.index - b.index);
      return { ...t, sections };
    }
    case 'answer':
      return { ...t, answer: event.rendered, spendDecisions: event.spendDecisions, flagged: event.flagged.length, repaired: event.repaired, sections: event.rendered.sections.map((s, i) => ({ index: i, key: s.key, body_md: s.body_md, verified: true })) };
    case 'usage':
      return { ...t, usage: { inputTokens: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWrite5mTokens + event.usage.cacheWrite1hTokens, outputTokens: event.usage.outputTokens, costUsd: event.costUsd, model: event.model } };
    case 'continue':
      return { ...t, status: 'continue' };
    case 'needs_confirmation':
      return { ...t, status: 'needs_confirmation', confirmation: { reason: event.reason, spentUsd: event.spentUsd, estimateUsd: null } };
    case 'error':
      return { ...t, status: 'failed', error: { message: event.message, retryable: event.retryable } };
    case 'stopped':
      return { ...t, status: 'stopped' };
    case 'done':
      return { ...t, status: event.status === 'done' ? 'done' : event.status === 'failed' ? 'failed' : event.status === 'stopped' ? 'stopped' : event.status === 'needs_confirmation' ? 'needs_confirmation' : 'continue' };
    case 'round':
      return t;
    default:
      return t;
  }
}

export function applyEvents(turn: TurnView, events: ReadonlyArray<{ event: AnalystEvent; index: number }>): TurnView {
  return events.reduce((acc, e) => applyEvent(acc, e.event, e.index), turn);
}

/** The thinking sub-line: the latest status, or "Thinking" before any. */
export function currentStatus(turn: TurnView): string {
  return turn.statuses[turn.statuses.length - 1] ?? 'Thinking';
}

/** "12.4K in · 3.1K out · $0.21 USD" */
export function usageLine(u: NonNullable<TurnView['usage']>): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
  return `${k(u.inputTokens)} in · ${k(u.outputTokens)} out · $${u.costUsd.toFixed(2)} USD`;
}

export interface ThreadTranscript {
  thread: { id: string; title: string | null; model: string };
  turns: Array<{ id: string; status: string; question: string; kind: string; costUsd: number | null; usage: Record<string, number> | null; error: string | null; events: AnalystEvent[] }>;
  transcript: Array<{ seq: number; turnId: string | null; role: string; display: Record<string, unknown> | null }>;
}

/** A stored thread as turn views: the question and explain from the user row, the rendered answer from the assistant row, the rest from the turn. */
export function turnsFromTranscript(t: ThreadTranscript): TurnView[] {
  return t.turns.map((turn) => {
    const rows = t.transcript.filter((r) => r.turnId === turn.id);
    const userRow = rows.find((r) => r.role === 'user' || r.role === 'tool_results');
    const answerRow = [...rows].reverse().find((r) => r.role === 'assistant' && r.display && 'rendered' in r.display);
    const d = (answerRow?.display ?? {}) as { rendered?: RenderedAnswer; spendDecisions?: SpendDecision[]; flagged?: unknown[]; repaired?: boolean };
    const kind: TurnView['kind'] = turn.kind === 'explain' || turn.kind === 'report' ? turn.kind : 'ask';
    const base = newTurnView({ clientTurnId: `stored:${turn.id}`, question: turn.question, kind, id: turn.id });
    const explain = (userRow?.display as { explain?: ExplainInfo } | null)?.explain ?? null;
    const status: TurnViewStatus = turn.status === 'done' ? 'done' : turn.status === 'failed' ? 'failed' : turn.status === 'stopped' ? 'stopped' : turn.status === 'needs_confirmation' ? 'needs_confirmation' : 'running';
    const usage = turn.usage && turn.costUsd !== null ? { inputTokens: (turn.usage.inputTokens ?? 0) + (turn.usage.cacheReadTokens ?? 0) + (turn.usage.cacheWrite5mTokens ?? 0) + (turn.usage.cacheWrite1hTokens ?? 0), outputTokens: turn.usage.outputTokens ?? 0, costUsd: turn.costUsd, model: t.thread.model } : null;
    const view: TurnView = { ...base, status, explain, answer: d.rendered ?? null, spendDecisions: d.spendDecisions ?? [], flagged: d.flagged?.length ?? 0, repaired: Boolean(d.repaired), usage, error: turn.error ? { message: turn.error, retryable: status === 'failed' } : null, sections: d.rendered ? d.rendered.sections.map((s, i) => ({ index: i, key: s.key, body_md: s.body_md, verified: true })) : [], lastEventIndex: turn.events?.length ?? 0 };
    // A turn still running when the thread was read: fold its stored events so the panel resumes where it was.
    return status === 'running' && turn.events?.length ? applyEvents({ ...view, lastEventIndex: 0 }, turn.events.map((event, i) => ({ event, index: i + 1 }))) : view;
  });
}

/** Local greeting for the welcome card. */
export function greeting(hour: number): string {
  return hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
}
