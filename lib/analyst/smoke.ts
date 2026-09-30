/**
 * Live conversation smoke (plan item 8): one question plus a 3-turn follow-up
 * against the real API and the real tools, on the in-memory store (nothing
 * written). Prints per turn:
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
  repaired: boolean;
  sections: string[];
  error: string | null;
  cacheRead: number;
}

export const SMOKE_TURNS: Array<Omit<TurnRequest, 'clientTurnId'>> = [
  { question: 'How did last week go, and what should we focus on this week?', kind: 'ask', context: { page: 'command_center', range: null, compare: 'previous_period' } },
  { question: 'And how does that compare with the week before?', kind: 'ask' },
  { question: 'Which campaign had the best cost per client in that period, and should we move budget?', kind: 'ask' },
  { question: '', kind: 'explain', explainKey: 'paid_cac', context: { page: 'ads', range: null } },
];

export function formatSmokeTurn(l: SmokeTurnLine): string {
  if (l.status === 'FAIL') return `FAIL turn ${l.turn} · "${l.question || '(explain paid_cac)'}" · ${l.tools} tools · ${l.cost} · ${l.seconds}s · ${l.error}`;
  return `PASS turn ${l.turn} · ${l.tools} tools · ${l.cost} · ${l.seconds}s${l.estimateUsd !== null ? ` · estimate ${formatUsd(l.estimateUsd)}` : ''}${l.cacheRead > 0 ? '' : ' · NO CACHE READ'} · sections ${l.sections.join(',')}${l.repaired ? ' · repaired once' : ''}${l.flagged ? ` · ${l.flagged} FLAGGED number(s)` : ''}\n     ↳ ${l.headline}`;
}

export async function runAnalystSmoke(opts: { log?: (line: string) => void } = {}): Promise<{ lines: SmokeTurnLine[]; ok: boolean; answerMode: string; model: string }> {
  const store = new MemoryAnalystStore();
  const config = await getAnalystConfig();
  const lines: SmokeTurnLine[] = [];
  let threadId: string | null = null;
  for (let i = 0; i < SMOKE_TURNS.length; i++) {
    const req = SMOKE_TURNS[i];
    const started = Date.now();
    let tools = 0;
    let cacheRead = 0;
    const onEvent = (e: AnalystEvent) => {
      if (e.type === 'tools') tools += e.calls.length;
      if (e.type === 'usage') cacheRead = e.usage.cacheReadTokens;
      if (e.type === 'status') opts.log?.(`   · ${e.text}`);
      if (e.type === 'tools') opts.log?.(`   · ${e.calls.map((c) => `${c.ref} ${c.name}`).join(', ')}`);
    };
    const prepared = await prepareTurn({ ...req, threadId, clientTurnId: `smoke-${i + 1}`, confirmedUsd: 3 }, { store, onEvent });
    if (!prepared.ok) {
      lines.push({ status: 'FAIL', turn: i + 1, question: req.question, tools: 0, cost: '$0.00 USD', estimateUsd: prepared.status === 'needs_confirmation' ? prepared.estimate.usd : null, seconds: 0, headline: null, flagged: 0, repaired: false, sections: [], error: prepared.status === 'needs_confirmation' ? prepared.reason : prepared.message, cacheRead: 0 });
      break;
    }
    threadId = prepared.thread.id;
    let out: TurnOutcome;
    try {
      out = await executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps);
    } catch (err) {
      lines.push({ status: 'FAIL', turn: i + 1, question: req.question, tools, cost: '$0.00 USD', estimateUsd: prepared.estimate.usd, seconds: Math.round((Date.now() - started) / 1000), headline: null, flagged: 0, repaired: false, sections: [], error: err instanceof Error ? err.message : String(err), cacheRead });
      break;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const turn = await store.getTurn(prepared.turn.id);
    const repaired = Boolean(turn?.events.some((e) => e.type === 'answer' && (e as { repaired?: boolean }).repaired));
    lines.push({
      status: out.status === 'done' && out.answer ? 'PASS' : 'FAIL',
      turn: i + 1,
      question: req.question,
      tools,
      cost: costLine(out.usage, out.costUsd),
      estimateUsd: prepared.estimate.usd,
      seconds,
      headline: out.answer?.headline.text ?? null,
      flagged: out.flagged.length,
      repaired,
      sections: out.answer?.sections.map((s) => s.key) ?? [],
      error: out.error ?? (out.status !== 'done' ? out.status : null),
      cacheRead,
    });
    if (out.status !== 'done') break;
  }
  const model = threadId ? ((await store.getThread(threadId))?.model ?? config.modelDefault) : config.modelDefault;
  return { lines, ok: lines.length === SMOKE_TURNS.length && lines.every((l) => l.status === 'PASS'), answerMode: config.answerMode, model };
}
