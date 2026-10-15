/**
 * Spend decisions by construction (Wave 2 tune-up 1, 2026-10-15) — PURE.
 *
 * The 2026-10-15 release measured four runs on the same data whose `spend:` lines differed while every decision
 * was a hold: the model enumerated the held campaigns freely ("hold account, hold Testing" vs "hold account").
 * The server now OWNS the spend decisions: exactly ONE per gate row, account first, then the campaigns in the
 * order the gate result lists them (spend descending). Per row:
 *
 *   gate hold        → decision hold, the action WRITTEN BY THE SERVER from the gate's own refs
 *                      ("Hold {campaign}: {basis}"), so it renders from the ledger and verifies by construction;
 *                      a model action that argued past the gate is replaced (noted, never a repair round);
 *   gate may_change  → the model's spend action for that campaign (increase / decrease / shift / hold) is kept
 *                      as written; none given → a server hold "no change proposed";
 *   a model spend action naming a campaign with no gate, or with spend_change "none" → dropped with the reason.
 *
 * Stale data (the notice) holds every row — the same server text, decided by the server. The model's non-spend
 * actions follow the decisions in the model's order. So the smoke's `spend:` line is a function of the gates
 * plus the model's calls on the may_change rows only, and two runs can only differ where the advice differs.
 */

import type { Ledger } from './ledger';
import type { Answer } from './schema';

export type GateDecision = 'may_change' | 'hold';
export type SpendChange = Exclude<Answer['actions'][number]['spend_change'], 'none'>;

export interface GateRow {
  /** "account" or the campaign name exactly as the tool result gives it. */
  campaign: string;
  decision: GateDecision;
  basis: string;
  /** The ledger path of the row ("r2:data.spendGates.campaigns[1]"): its leaves are the refs the server cites. */
  base: string;
  needsEnrollments: number | null;
  needsWeeks: number | null;
}

export interface SpendDecision {
  campaign: string;
  gate: GateDecision;
  basis: string;
  decision: SpendChange;
  decidedBy: 'server' | 'model';
  /** The ledger ref of the gate decision this row rests on. */
  ref: string;
}

export interface SpendDecisionsResult {
  /** The answer with its spend actions replaced by the decisions (first, in gate order), then the other actions. */
  answer: Answer;
  decisions: SpendDecision[];
  /** What the server replaced or dropped, one line each (status events, never silent). */
  notes: string[];
  /** Indexes into the INPUT answer's actions that survive as written (non-spend actions, and the model's call on a may_change row). */
  keptIndexes: number[];
}

export interface SpendDecisionOptions {
  /** A source is stale this turn: every row holds, whatever the gate said when it was fetched. */
  stale: boolean;
  /** YYYY-MM-DD for the server-written holds. */
  checkDate: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The NEWEST gate set in the ledger (the highest round among get_scorecard's `spendGates` and get_campaigns'
 * `gates`), account first, campaigns in the result's own order. Null when no gate result is in the conversation.
 */
export function latestGates(ledger: Ledger): GateRow[] | null {
  const bases = new Map<string, number>();
  for (const r of ledger.refs()) {
    const m = /^(r(\d+):data\.(?:spendGates|gates))\.account\.decision$/.exec(r);
    if (m) bases.set(m[1], Number(m[2]));
  }
  if (bases.size === 0) return null;
  const base = [...bases.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const row = (path: string, fallbackName: string | null): GateRow | null => {
    const decision = ledger.get(`${path}.decision`)?.text;
    if (decision !== 'may_change' && decision !== 'hold') return null;
    const campaign = ledger.get(`${path}.campaign`)?.text ?? fallbackName;
    if (!campaign) return null;
    const num = (leaf: string) => {
      const e = ledger.get(`${path}.${leaf}`);
      return e && e.unit !== 'text' && typeof e.value === 'number' ? e.value : null;
    };
    return { campaign, decision, basis: ledger.get(`${path}.basis`)?.text ?? '', base: path, needsEnrollments: num('needsEnrollments'), needsWeeks: num('needsWeeks') };
  };
  const rows: GateRow[] = [];
  const account = row(`${base}.account`, 'account');
  if (account) rows.push({ ...account, campaign: 'account' });
  for (let i = 0; ; i++) {
    const r = row(`${base}.campaigns[${i}]`, null);
    if (!r) break;
    rows.push(r);
  }
  return rows;
}

type Action = Answer['actions'][number];

/** A hold the server writes from the gate's refs: every number and name is a token, so it renders and verifies by construction. */
function serverHold(g: GateRow, why: string, checkDate: string): Action {
  return {
    action: `Hold {${g.base}.campaign}: {${g.base}.basis}`,
    why,
    owner: 'Owner',
    kind: 'spend',
    campaign: g.campaign,
    spend_change: 'hold',
    expected_impact: 'none while the gate holds',
    confidence: 'high',
    metric: 'spend_gate',
    check_date: checkDate,
  };
}

function opensWith(g: GateRow): string {
  const parts: string[] = [];
  if (g.needsEnrollments !== null && g.needsEnrollments > 0) parts.push(`{${g.base}.needsEnrollments} more tracked enrollments`);
  if (g.needsWeeks !== null && g.needsWeeks > 0) parts.push(`{${g.base}.needsWeeks} more weeks with spend`);
  return parts.length ? `The gate is computed by the server; it opens with ${parts.join(' and ')}.` : 'The gate is computed by the server; nothing to change until it opens.';
}

/** The decisions for an answer: one per gate row in gate order, then the model's other actions. */
export function applySpendDecisions(answer: Answer, ledger: Ledger, opts: SpendDecisionOptions): SpendDecisionsResult {
  const gates = latestGates(ledger);
  const modelSpend = answer.actions.filter((a) => a.kind === 'spend');
  const others = answer.actions.filter((a) => a.kind !== 'spend');
  const indexOf = new Map(answer.actions.map((a, i) => [a, i] as const));
  const notes: string[] = [];
  if (!gates) {
    for (const a of modelSpend) notes.push(`spend action "${a.action}" dropped: no spend gate in this conversation — the server decides spend from get_scorecard.spendGates / get_campaigns.gates`);
    return { answer: { ...answer, actions: others }, decisions: [], notes, keptIndexes: others.map((a) => indexOf.get(a)!) };
  }
  const used = new Set<Action>();
  const decisions: SpendDecision[] = [];
  const actions: Action[] = [];
  for (const g of gates) {
    const mine = modelSpend.filter((a) => !used.has(a) && norm(a.campaign || 'account') === norm(g.campaign));
    for (const a of mine) used.add(a);
    const ref = `${g.base}.decision`;
    const proposed = mine.find((a) => a.spend_change !== 'none') ?? null;
    for (const a of mine) if (a.spend_change === 'none') notes.push(`spend action "${a.action}" dropped: spend_change is "none"`);
    if (opts.stale) {
      if (proposed && proposed.spend_change !== 'hold') notes.push(`spend action "${proposed.action}" (${proposed.spend_change} ${g.campaign}) replaced by a hold: a data source is stale`);
      actions.push(serverHold(g, 'A data source is stale; no spend change until the sync completes.', opts.checkDate));
      decisions.push({ campaign: g.campaign, gate: g.decision, basis: g.basis, decision: 'hold', decidedBy: 'server', ref });
    } else if (g.decision === 'hold') {
      if (proposed && proposed.spend_change !== 'hold') notes.push(`spend action "${proposed.action}" (${proposed.spend_change} ${g.campaign}) replaced by the gate's hold: ${g.basis}`);
      actions.push(serverHold(g, opensWith(g), opts.checkDate));
      decisions.push({ campaign: g.campaign, gate: 'hold', basis: g.basis, decision: 'hold', decidedBy: 'server', ref });
    } else if (proposed) {
      actions.push(proposed);
      decisions.push({ campaign: g.campaign, gate: 'may_change', basis: g.basis, decision: proposed.spend_change as SpendChange, decidedBy: 'model', ref });
      for (const extra of mine.filter((a) => a !== proposed && a.spend_change !== 'none')) notes.push(`spend action "${extra.action}" dropped: one decision per campaign (${g.campaign} already has "${proposed.spend_change}")`);
    } else {
      actions.push({ ...serverHold(g, `The gate allows a change ({${g.base}.basis}); the answer proposed none.`, opts.checkDate), action: `Hold {${g.base}.campaign}: no change proposed` });
      decisions.push({ campaign: g.campaign, gate: 'may_change', basis: g.basis, decision: 'hold', decidedBy: 'server', ref });
    }
  }
  for (const a of modelSpend) if (!used.has(a)) notes.push(`spend action "${a.action}" dropped: no spend gate for "${a.campaign || 'account'}" in this conversation — fetch get_campaigns and name the campaign exactly as it gives it`);
  const keptIndexes = [...actions, ...others].map((a) => indexOf.get(a)).filter((i): i is number => i !== undefined).sort((x, y) => x - y);
  return { answer: { ...answer, actions: [...actions, ...others] }, decisions, notes, keptIndexes };
}

/**
 * The smoke's comparable line: "spend: hold account, hold July 16*, hold Scaling" — gate order, `*` marks a call the
 * model made on a may_change row (the only place two runs can legitimately differ). "spend: none" without gates.
 */
export function spendDecisionsLine(decisions: ReadonlyArray<SpendDecision>): string {
  return `spend: ${decisions.length ? decisions.map((d) => `${d.decision} ${d.campaign}${d.decidedBy === 'model' ? '*' : ''}`).join(', ') : 'none'}`;
}
