/**
 * Live conversation smoke (plan item 8): ONE question by default (item 7 — the
 * cheap check, target ≤ $0.40 USD); `--full` runs the whole conversation (a
 * follow-up, a budget question, the memory check, an explain) before a release.
 * Real API, real tools, in-memory store (nothing written). Prints per turn:
 *   PASS turn 1 · 3 tools · 18.2K in (15.9K cached) · 2.4K out · $0.19 USD · 21 s · estimate $0.31 USD
 * and states whether answers used output_config.format or submit_answer.
 */

import { executeTurn, prepareTurn, type TurnRequest } from './service';
import { MemoryAnalystStore } from './store';
import { costLine, type AnalystEvent, type TurnOutcome } from './run';
import { formatUsd } from './cost';
import { getAnalystConfig } from './config';

export interface SmokeTurnLine {
  status: 'PASS' | 'FAIL';
  turn: number;
  question: string;
  tools: number;
  cost: string;
  estimateUsd: number | null;
  seconds: number;
  headline: string | null;
  flagged: number;
  /** Repair turns this turn took, counted from ITS OWN events (0 or 1). */
  repairs: number;
  /** The answer's note proposals (kept in memory by the smoke — nothing is written). */
  proposals: string[];
  sections: string[];
  error: string | null;
  cacheRead: number;
}

export interface SmokeTurn extends Omit<TurnRequest, 'clientTurnId'> {
  /** Item 6 (memory check): this turn states a durable fact — the answer must carry ≥ 1 note proposal. */
  expectsProposal?: boolean;
}

export const SMOKE_TURNS: SmokeTurn[] = [
  { question: 'How did last week go, and what should we focus on this week?', kind: 'ask', context: { page: 'command_center', range: null, compare: 'previous_period' } },
  { question: 'And how does that compare with the week before?', kind: 'ask' },
  { question: 'Which campaign had the best cost per client in that period, and should we move budget?', kind: 'ask' },
  { question: 'For the record: from October we cap Meta spend at $4,000 CAD a month. Does that change your advice?', kind: 'ask', expectsProposal: true },
  { question: '', kind: 'explain', explainKey: 'paid_cac', context: { page: 'ads', range: null } },
];

export function formatSmokeTurn(l: SmokeTurnLine): string {
  if (l.status === 'FAIL') return `FAIL turn ${l.turn} · "${l.question || '(explain paid_cac)'}" · ${l.tools} tools · ${l.cost} · ${l.seconds}s · ${l.error}`;
  return `PASS turn ${l.turn} · ${l.tools} tools · ${l.cost} · ${l.seconds}s${l.estimateUsd !== null ? ` · estimate ${formatUsd(l.estimateUsd)}` : ''}${l.cacheRead > 0 ? '' : ' · NO CACHE READ'} · sections ${l.sections.join(',')} · repairs ${l.repairs}${l.flagged ? ` · ${l.flagged} FLAGGED number(s)` : ''}${l.proposals.length ? ` · ${l.proposals.length} note proposal(s): ${l.proposals.map((p) => `"${p}"`).join(' | ')}` : ''}\n     ↳ ${l.headline}`;
}

export interface SmokeOptions {
  log?: (line: string) => void;
  /** Item 7: the default run is ONE turn (target ≤ $0.40 USD); `full` runs the whole conversation — before a release only. */
  full?: boolean;
  /** Item 8: the hard USD budget for the whole run (default 1.00). Before every request, spent + the next request's estimate must fit. */
  maxUsd?: number;
}

export const DEFAULT_MAX_USD = 1;

/** "Stopped at $0.84 of $1.00 USD budget — the next request was estimated at $0.31 USD" */
export function budgetStopMessage(spentUsd: number, maxUsd: number, nextUsd: number | null): string {
  return `Stopped at ${formatUsd(spentUsd)} of ${formatUsd(maxUsd)} budget${nextUsd !== null ? ` — the next request was estimated at ${formatUsd(nextUsd)}` : ''}`;
}

/** Item 8 (pure): may the next request be sent? `spent + next` must stay within the budget. */
export function withinBudget(spentUsd: number, nextUsd: number, maxUsd: number): boolean {
  return spentUsd + nextUsd <= maxUsd + 1e-9;
}

/** `--max-usd 1.50` or `--max-usd=1.50`; a value that is not a positive number is refused, never defaulted silently. */
export function parseMaxUsd(args: string[]): number {
  const i = args.findIndex((a) => a === '--max-usd' || a.startsWith('--max-usd='));
  if (i < 0) return DEFAULT_MAX_USD;
  const raw = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) throw new Error(`--max-usd needs a positive USD amount, got "${raw ?? ''}"`);
  return n;
}

export const costUsdOf = (costLineText: string) => Number((/\$([\d.]+) USD$/.exec(costLineText) ?? [])[1] ?? 0);

/** The turns a run exercises: the first one by default, all of them with --full. */
export function smokeTurns(opts: Pick<SmokeOptions, 'full'>): SmokeTurn[] {
  return opts.full ? SMOKE_TURNS : SMOKE_TURNS.slice(0, 1);
}

export async function runAnalystSmoke(opts: SmokeOptions = {}): Promise<{ lines: SmokeTurnLine[]; ok: boolean; answerMode: string; model: string; turns: number; spentUsd: number; maxUsd: number; budgetStopped: boolean }> {
  const store = new MemoryAnalystStore();
  const config = await getAnalystConfig();
  const lines: SmokeTurnLine[] = [];
  const turns = smokeTurns(opts);
  const maxUsd = opts.maxUsd ?? DEFAULT_MAX_USD;
  let spentUsd = 0;
  let budgetStopped = false;
  let threadId: string | null = null;
  const fail = (turn: number, question: string, error: string, extra: Partial<SmokeTurnLine> = {}) => lines.push({ status: 'FAIL', turn, question, tools: 0, cost: '$0.00 USD', estimateUsd: null, seconds: 0, headline: null, flagged: 0, repairs: 0, proposals: [], sections: [], error, cacheRead: 0, ...extra });
  for (let i = 0; i < turns.length; i++) {
    const req = turns[i];
    const started = Date.now();
    let tools = 0;
    let cacheRead = 0;
    const onEvent = (e: AnalystEvent) => {
      if (e.type === 'tools') tools += e.calls.length;
      if (e.type === 'usage') cacheRead = e.usage.cacheReadTokens;
      if (e.type === 'status') opts.log?.(`   turn ${i + 1} · ${e.text}`);
      if (e.type === 'tools') opts.log?.(`   turn ${i + 1} · ${e.calls.map((c) => `${c.ref} ${c.name}`).join(', ')}`);
    };
    // Nothing is written: proposals are collected here, not saved as notes.
    const proposals: string[] = [];
    const { expectsProposal: _expects, ...turnReq } = req;
    // The remaining budget is what this turn may spend: the cap decision refuses a turn whose estimate does not fit,
    // and the loop pauses between rounds (needs_confirmation) when spent + the next request would not — both read
    // here as the budget stop. Nothing is sent past the budget.
    const remaining = Math.max(0, maxUsd - spentUsd);
    const prepared = await prepareTurn({ ...turnReq, threadId, clientTurnId: `smoke-${i + 1}`, confirmedUsd: remaining }, { store, onEvent, onProposals: async (texts) => { proposals.push(...texts); return { saved: 0, skipped: texts.length }; } });
    if (!prepared.ok) {
      if (prepared.status === 'needs_confirmation') {
        budgetStopped = true;
        fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, prepared.estimate.usd), { estimateUsd: prepared.estimate.usd });
      } else fail(i + 1, req.question, prepared.message);
      break;
    }
    threadId = prepared.thread.id;
    // The per-run cap ($3) may admit a turn the smoke budget cannot: check here, before the first request is sent.
    if (!withinBudget(spentUsd, prepared.estimate.usd, maxUsd)) {
      budgetStopped = true;
      fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, prepared.estimate.usd), { estimateUsd: prepared.estimate.usd });
      break;
    }
    let out: TurnOutcome;
    try {
      out = await executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps);
    } catch (err) {
      fail(i + 1, req.question, err instanceof Error ? err.message : String(err), { tools, estimateUsd: prepared.estimate.usd, seconds: Math.round((Date.now() - started) / 1000), cacheRead });
      break;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const turn = await store.getTurn(prepared.turn.id);
    spentUsd += out.costUsd;
    if (out.status === 'needs_confirmation') {
      budgetStopped = true;
      fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, null), { tools, cost: costLine(out.usage, out.costUsd), estimateUsd: prepared.estimate.usd, seconds, cacheRead });
      break;
    }
    // Counted from this turn's own events, so the line and the "Repairing…" log lines above it agree.
    const repairs = turn?.events.filter((e) => e.type === 'status' && (e as { text?: string }).text === 'Repairing the answer…').length ?? 0;
    const memoryMiss = req.expectsProposal && proposals.length === 0;
    lines.push({
      status: out.status === 'done' && out.answer && !memoryMiss ? 'PASS' : 'FAIL',
      turn: i + 1,
      question: req.question,
      tools,
      cost: costLine(out.usage, out.costUsd),
      estimateUsd: prepared.estimate.usd,
      seconds,
      headline: out.answer?.headline.text ?? null,
      flagged: out.flagged.length,
      repairs,
      sections: out.answer?.sections.map((s) => s.key) ?? [],
      proposals,
      error: out.error ?? (out.status !== 'done' ? out.status : memoryMiss ? 'memory check: the owner stated a durable fact but the answer proposed no note' : null),
      cacheRead,
    });
    if (out.status !== 'done') break;
  }
  const model = threadId ? ((await store.getThread(threadId))?.model ?? config.modelDefault) : config.modelDefault;
  return { lines, ok: lines.length === turns.length && lines.every((l) => l.status === 'PASS'), answerMode: config.answerMode, model, turns: turns.length, spentUsd, maxUsd, budgetStopped };
}
