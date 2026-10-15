/**
 * One eval turn on the in-memory store (Wave 2 item 12): the real prepare → execute path (snapshot, tools, verifier,
 * render) against the database .env.local points at, nothing written — the same path the smoke uses. Returns the
 * outcome, the log rows (for the ledger), every event and the wall time.
 */

import { MemoryAnalystStore } from './store';
import { executeTurn, prepareTurn, type TurnRequest } from './service';
import type { AnalystEvent, TurnOutcome } from './run';
import type { MessageRow } from './store';

export interface EvalTurnResult {
  ok: boolean;
  message: string | null;
  outcome: TurnOutcome | null;
  rows: MessageRow[];
  events: AnalystEvent[];
  seconds: number;
  costUsd: number;
  estimateUsd: number | null;
  threadId: string | null;
}

export class EvalThread {
  readonly store = new MemoryAnalystStore();
  threadId: string | null = null;
  private n = 0;

  async run(req: Omit<TurnRequest, 'threadId' | 'clientTurnId'>, opts: { allowUsd: number; log?: (line: string) => void } ): Promise<EvalTurnResult> {
    const started = Date.now();
    const events: AnalystEvent[] = [];
    this.n += 1;
    const prepared = await prepareTurn({ ...req, threadId: this.threadId, clientTurnId: `eval-${this.n}`, confirmedUsd: opts.allowUsd }, {
      store: this.store,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'status') opts.log?.(`      ${e.text}`);
      },
      // Nothing is written: proposals are dropped.
      onProposals: async (texts) => ({ saved: 0, skipped: texts.length }),
    });
    if (!prepared.ok) return { ok: false, message: prepared.status === 'needs_confirmation' ? `estimate $${prepared.estimate.usd.toFixed(2)} USD above the allowance` : prepared.message, outcome: null, rows: [], events, seconds: 0, costUsd: 0, estimateUsd: prepared.status === 'needs_confirmation' ? prepared.estimate.usd : null, threadId: prepared.thread?.id ?? null };
    this.threadId = prepared.thread.id;
    const outcome = await executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps);
    const rows = await this.store.listMessages(prepared.thread.id);
    return { ok: outcome.status === 'done', message: outcome.error, outcome, rows, events, seconds: Math.round((Date.now() - started) / 10) / 100, costUsd: outcome.costUsd, estimateUsd: prepared.estimate.usd, threadId: prepared.thread.id };
  }
}
