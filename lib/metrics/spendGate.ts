/**
 * Spend decision gates (Oct 7 item 1, 2026-10-07) — PURE. Two Analyst runs on the same data advised "shift half
 * of Scaling's budget" and "keep spend flat": the sample behind a spend change was never checked. The gate is
 * computed by code, delivered as refs, and the verifier holds every spend action to it.
 *
 * Window: the clean trailing weeks of the stage-history family (enrollments are history-dependent, so weeks
 * before `history_complete_since` are excluded — `lib/metrics/baseline.ts`). Per campaign (and `account`, all
 * campaigns summed): tracked enrollments and weeks with spend over the window.
 *
 *   may_change  when trackedEnrollments ≥ SPEND_GATE.minEnrollments AND weeksWithSpend ≥ SPEND_GATE.minWeeks
 *   hold        otherwise, with what is missing: "needs 2 more tracked enrollments (2 of 4) and 1 more complete
 *               week with spend (3 of 4)"; no spend in the window; or fewer clean weeks than the gate needs.
 *
 * Stale data turns every gate to hold (`holdForStale`, applied where freshness is known — the tool layer).
 * Thresholds are the glossary's (`spend_gate`); one constant each.
 */

import type { WeekBucket } from '../dates';
import { computeCampaignTable, normalizeCampaign, type MetricsInput } from './index';
import type { Currency } from '../money';

export const SPEND_GATE = { minEnrollments: 4, minWeeks: 4 } as const;
export const SPEND_GATE_RULE = `a campaign's spend may change only with ≥ ${SPEND_GATE.minEnrollments} tracked enrollments over ≥ ${SPEND_GATE.minWeeks} complete weeks with spend in the clean trailing window; otherwise hold, naming what is missing`;

export type GateDecision = 'may_change' | 'hold';
export const ACCOUNT = 'account';

export interface SpendGate {
  /** The campaign name as the Ads tab shows it, or "account". */
  campaign: string;
  platform: string | null;
  decision: GateDecision;
  /** Citeable phrase (≤ 12 words): "2 of 4 tracked enrollments, 3 of 4 weeks with spend". */
  basis: string;
  /** The sentence (explanatory, not citeable). */
  reason: string;
  trackedEnrollments: number;
  weeksWithSpend: number;
  weeksInWindow: number;
  needsEnrollments: number;
  needsWeeks: number;
  spendCents: number;
  currency: Currency | null;
}

export interface SpendGates {
  window: { start: string | null; end: string | null; weeksUsed: number; note: string | null };
  account: SpendGate;
  campaigns: SpendGate[];
}

/** The decision for one campaign's counts — the thresholds in one place. */
export function gateFor(p: { campaign: string; platform: string | null; trackedEnrollments: number; weeksWithSpend: number; weeksInWindow: number; spendCents: number; currency: Currency | null; windowNote?: string | null }): SpendGate {
  const needsEnrollments = Math.max(0, SPEND_GATE.minEnrollments - p.trackedEnrollments);
  const needsWeeks = Math.max(0, SPEND_GATE.minWeeks - p.weeksWithSpend);
  const base = { campaign: p.campaign, platform: p.platform, trackedEnrollments: p.trackedEnrollments, weeksWithSpend: p.weeksWithSpend, weeksInWindow: p.weeksInWindow, needsEnrollments, needsWeeks, spendCents: p.spendCents, currency: p.currency };
  if (p.windowNote) return { ...base, decision: 'hold', basis: `window too short: ${p.weeksInWindow} of ${SPEND_GATE.minWeeks} clean weeks`, reason: `hold — ${p.windowNote}` };
  if (p.spendCents === 0) return { ...base, decision: 'hold', basis: 'no spend in the window', reason: 'hold — no spend in the clean trailing window; there is no spend to change' };
  const basis = `${p.trackedEnrollments} of ${SPEND_GATE.minEnrollments} tracked enrollments, ${p.weeksWithSpend} of ${SPEND_GATE.minWeeks} weeks with spend`;
  if (needsEnrollments === 0 && needsWeeks === 0) {
    return { ...base, decision: 'may_change', basis: `${p.trackedEnrollments} tracked enrollments over ${p.weeksWithSpend} weeks with spend`, reason: `may change — ${p.trackedEnrollments} tracked enrollments over ${p.weeksWithSpend} weeks with spend meet the gate (${SPEND_GATE.minEnrollments} and ${SPEND_GATE.minWeeks})` };
  }
  const missing = [
    needsEnrollments > 0 ? `${needsEnrollments} more tracked enrollment${needsEnrollments === 1 ? '' : 's'} (${p.trackedEnrollments} of ${SPEND_GATE.minEnrollments})` : null,
    needsWeeks > 0 ? `${needsWeeks} more complete week${needsWeeks === 1 ? '' : 's'} with spend (${p.weeksWithSpend} of ${SPEND_GATE.minWeeks})` : null,
  ].filter((x): x is string => Boolean(x));
  return { ...base, decision: 'hold', basis, reason: `hold — insufficient sample: needs ${missing.join(' and ')}` };
}

/** Gates for every campaign that spent in the window, plus the account total. `weeks` = the CLEAN stage-history weeks. */
export function computeSpendGates(input: MetricsInput, weeks: WeekBucket[], windowNote: string | null = null): SpendGates {
  type Acc = { campaign: string; platform: string | null; enrolled: number; weeksWithSpend: number; spendCents: number; currency: Currency | null };
  const byKey = new Map<string, Acc>();
  const account: Acc = { campaign: ACCOUNT, platform: null, enrolled: 0, weeksWithSpend: 0, spendCents: 0, currency: null };
  for (const w of weeks) {
    let accountSpent = false;
    for (const c of computeCampaignTable(input, w)) {
      const k = `${c.platform}:${normalizeCampaign(c.campaignName)}`;
      const acc = byKey.get(k) ?? { campaign: c.campaignName, platform: c.platform, enrolled: 0, weeksWithSpend: 0, spendCents: 0, currency: null };
      acc.enrolled += c.tracked.enrolled;
      acc.spendCents += c.spendCents;
      if (c.spendCents > 0) {
        acc.weeksWithSpend += 1;
        acc.currency = c.currency;
        accountSpent = true;
      }
      byKey.set(k, acc);
      account.enrolled += c.tracked.enrolled;
      account.spendCents += c.spendCents;
      if (c.spendCents > 0) account.currency = c.currency;
    }
    if (accountSpent) account.weeksWithSpend += 1;
  }
  const toGate = (a: Acc) => gateFor({ campaign: a.campaign, platform: a.platform, trackedEnrollments: a.enrolled, weeksWithSpend: a.weeksWithSpend, weeksInWindow: weeks.length, spendCents: a.spendCents, currency: a.currency, windowNote });
  const campaigns = [...byKey.values()].filter((a) => a.spendCents > 0).sort((a, b) => b.spendCents - a.spendCents || a.campaign.localeCompare(b.campaign)).map(toGate);
  return { window: { start: weeks[0]?.start ?? null, end: weeks[weeks.length - 1]?.end ?? null, weeksUsed: weeks.length, note: windowNote }, account: toGate(account), campaigns };
}

/** Stale data: every gate holds, with the freshness phrase as the basis. Pure. */
export function holdForStale(gates: SpendGates, phrase: string): SpendGates {
  const hold = (g: SpendGate): SpendGate => ({ ...g, decision: 'hold', basis: `data stale: ${phrase}`, reason: `hold — a data source is stale (${phrase}); re-run after the sync completes` });
  return { ...gates, account: hold(gates.account), campaigns: gates.campaigns.map(hold) };
}

/** The gate a spend action is held to: by campaign name (normalised), or the account. */
export function gateForAction(gates: SpendGates, campaign: string): SpendGate | null {
  const c = campaign.trim();
  if (!c || c.toLowerCase() === ACCOUNT) return gates.account;
  return gates.campaigns.find((g) => normalizeCampaign(g.campaign) === normalizeCampaign(c)) ?? null;
}

/** "spend gates: Summer Shred — Broad may change (6 tracked enrollments over 5 weeks with spend) · Brand Search hold (…)" */
export function gatesLine(gates: SpendGates): string {
  const all = [gates.account, ...gates.campaigns];
  return `spend gates: ${all.map((g) => `${g.campaign} ${g.decision === 'may_change' ? 'may change' : 'hold'} (${g.basis})`).join(' · ')}`;
}
