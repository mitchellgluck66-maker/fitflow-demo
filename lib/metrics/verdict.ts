/**
 * The week verdict (2026-10-06, 1b) — PURE and deterministic. "Strong / normal / weak" is decided by CODE from
 * Stripe-confirmed facts — new paying clients (first payments, `computeRevenue(...).initialCount`) and
 * new-client cash — against the clean trailing baseline (lib/metrics/baseline.ts; Stripe is dated by its
 * own source, so every complete week counts). The Analyst receives it as a ref and explains it; it never
 * decides it. The thresholds are stated in the glossary entry `week_verdict`:
 *
 *   rc = clients ÷ avg clients/week, r$ = cash ÷ avg cash/week
 *   strong  when rc ≥ 1.3 and r$ ≥ 1.0, or r$ ≥ 1.3 and rc ≥ 1.0
 *   weak    when rc ≤ 0.7 and r$ ≤ 1.0, or r$ ≤ 0.7 and rc ≤ 1.0
 *   normal  otherwise
 *   unavailable — Stripe not connected, fewer than 4 complete baseline weeks, or a baseline average of 0
 *
 * A GHL "enrolled" entry is a stage move; a new client is a first payment.
 */

import { formatMoney as formatCents } from '../money';
import { weekStart, weekEnd } from '../dates';
import { computeRevenue, inReportingCurrency, type MetricsInput, type Range } from './index';
import type { CleanBaseline } from './baseline';

export type Verdict = 'strong' | 'normal' | 'weak' | 'unavailable';

export const VERDICT_THRESHOLDS = { strong: 1.3, weak: 0.7, minWeeks: 4 } as const;
export const VERDICT_RULE = `strong when new paying clients ≥ ${VERDICT_THRESHOLDS.strong}× the baseline with cash ≥ 1.0× (or cash ≥ ${VERDICT_THRESHOLDS.strong}× with clients ≥ 1.0×); weak when clients ≤ ${VERDICT_THRESHOLDS.weak}× with cash ≤ 1.0× (or cash ≤ ${VERDICT_THRESHOLDS.weak}× with clients ≤ 1.0×); normal otherwise; unavailable without Stripe, with fewer than ${VERDICT_THRESHOLDS.minWeeks} complete baseline weeks, or with a zero baseline`;

export interface WeekVerdict {
  verdict: Verdict;
  /** The sentence the server renders from the same numbers (an explanation — not citeable; the basis phrases are). */
  reason: string;
  /** Citeable phrases (Oct 7 item 4): "4 new paying clients vs 4/week over 8 weeks (1.00×)", "$12,000 CAD new-client cash vs $12,000 CAD/week (1.00×)"; null when unavailable. */
  basisClients: string | null;
  basisCash: string | null;
  rule: string;
  /** Stripe first payments in the week. */
  clients: number | null;
  cashCents: number | null;
  baselineClientsPerWeek: number | null;
  baselineCashPerWeekCents: number | null;
  ratioClients: number | null;
  ratioCash: number | null;
  weeksUsed: number;
  baselineSummary: string;
  currency: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeWeekVerdict(raw: MetricsInput, week: Range, baseline: CleanBaseline): WeekVerdict {
  const input = inReportingCurrency(raw);
  const ccy = input.money.reporting;
  const rev = computeRevenue(input, week);
  const base = { verdict: 'unavailable' as Verdict, rule: VERDICT_RULE, basisClients: null, basisCash: null, clients: null, cashCents: null, baselineClientsPerWeek: null, baselineCashPerWeekCents: null, ratioClients: null, ratioCash: null, weeksUsed: baseline.weeks.length, baselineSummary: baseline.summary, currency: ccy };
  if (rev.awaitingStripe) return { ...base, reason: 'Stripe is not connected — new clients are counted from first payments' };
  if (!baseline.enough) return { ...base, clients: rev.initialCount, cashCents: rev.initialCents, reason: baseline.note ?? "baseline not available" };
  const weekly = baseline.weeks.map((w) => computeRevenue(input, { start: w.start, end: w.end }));
  const avgClients = weekly.reduce((a, r) => a + r.initialCount, 0) / weekly.length;
  const avgCash = weekly.reduce((a, r) => a + r.initialCents, 0) / weekly.length;
  const partial = { ...base, clients: rev.initialCount, cashCents: rev.initialCents, baselineClientsPerWeek: r2(avgClients), baselineCashPerWeekCents: Math.round(avgCash) };
  if (avgClients === 0 || avgCash === 0) return { ...partial, reason: `the ${baseline.weeks.length}-week baseline has no new paying clients to compare against` };
  const rc = rev.initialCount / avgClients;
  const rd = rev.initialCents / avgCash;
  const { strong, weak } = VERDICT_THRESHOLDS;
  const verdict: Verdict = (rc >= strong && rd >= 1) || (rd >= strong && rc >= 1) ? 'strong' : (rc <= weak && rd <= 1) || (rd <= weak && rc <= 1) ? 'weak' : 'normal';
  const x = (n: number) => `${r2(n).toFixed(2)}×`;
  const basisClients = `${rev.initialCount} new paying client${rev.initialCount === 1 ? '' : 's'} vs ${r2(avgClients)}/week over ${baseline.weeks.length} weeks (${x(rc)})`;
  const basisCash = `${formatCents(rev.initialCents, ccy)} new-client cash vs ${formatCents(Math.round(avgCash), ccy)}/week (${x(rd)})`;
  // The reason never restates the verdict word (Oct 7: "Verdict: normal. normal: 4 new…" read twice) — the word is `verdict`.
  return { ...partial, verdict, reason: `${basisClients}; ${basisCash}`, basisClients, basisCash, ratioClients: r2(rc), ratioCash: r2(rd) };
}

/** The verdict for a scorecard range: computed only for exactly one Sun–Sat week; otherwise unavailable, with the reason. */
export function weekVerdictFor(raw: MetricsInput, range: Range, baseline: CleanBaseline): WeekVerdict {
  if (weekStart(range.start) !== range.start || weekEnd(range.start) !== range.end) {
    const ccy = inReportingCurrency(raw).money.reporting;
    return { verdict: 'unavailable', reason: `the verdict is weekly (one Sun–Sat week); this range is ${range.start} – ${range.end}`, rule: VERDICT_RULE, basisClients: null, basisCash: null, clients: null, cashCents: null, baselineClientsPerWeek: null, baselineCashPerWeekCents: null, ratioClients: null, ratioCash: null, weeksUsed: baseline.weeks.length, baselineSummary: baseline.summary, currency: ccy };
  }
  return computeWeekVerdict(raw, range, baseline);
}
