/**
 * The golden eval's cases (Wave 2 item 12, 2026-10-15) — PURE.
 *
 * numbers (25): a question whose headline figure must equal the INDEPENDENT SQL (scripts/verify.sql, the harness's
 * `out` JSON per range) — counts and cents exact, ratios within 0.0005. The expected value is derived here from the
 * SQL JSON with the same rules the harness applies (Paid CAC = spend ÷ paid enrollments rounded to cents, ROAS =
 * paid-attributed initial cash ÷ spend, a show rate only with ≥ 90 % attendance coverage; cash figures are the SQL's
 * sums as the harness compares them — ROAS alone is withheld without Stripe), never from the engine.
 * explain (10 × 2): "What does this mean?" for a metric and a range — three sections, the formula box equal to the
 * engine, nothing flagged. behaviour (5): on the seeded demo tenant — stale data, a healthy metric, an ambiguous
 * question, a 5-turn context conversation, a campaign-row question.
 */

export type EvalRangeKey = 'week' | 'month' | 'mtd' | 'jul16';

export const RANGE_PHRASES: Record<EvalRangeKey, string> = {
  week: 'last week (the last complete Sunday–Saturday week)',
  month: 'last month (the last complete calendar month)',
  mtd: 'this month so far (month to date)',
  jul16: 'from July 16, 2026 to today',
};

export type ExpectedUnit = 'count' | 'cents' | 'ratio' | 'verdict';

export interface NumbersQuestion {
  id: string;
  range: EvalRangeKey;
  question: string;
  /** What the headline figure is, for the report. */
  metric: string;
  unit: ExpectedUnit;
  /** The expected value from the independent SQL's `out` JSON for the range (null = withheld: the answer must say so). */
  expected: (S: SqlOut) => number | null;
}

/**
 * The slice of verify.sql's `out` JSON the questions read. Every aggregate is NULLABLE: `json_object_agg` over no rows
 * is null (a week with no enrollment has no `enrolled_by_att`, no funnel row makes `period` null, a currency with no
 * money row has null sums) — a null here means "not available", never a crash (2026-10-18: n07 crashed on a Sunday
 * whose last week had no enrollment).
 */
export interface SqlOut {
  period: Record<string, number | null> | null;
  cohort: Record<string, number | null> | null;
  has_stripe: boolean;
  enrolled_by_att: Record<string, number | null> | null;
  show_rates: Array<{ type: string; past: number | null; showed: number | null; no_show: number | null; cancelled: number | null }> | null;
  by_ccy: Record<string, SqlMoney | null | undefined> | null;
}
export interface SqlMoney {
  spend: number | null; initial_c: number | null; initial_n: number | null; recurring_c: number | null; collected: number | null; refunded_c: number | null; failed_n: number | null; mrr: number | null; contract_value: number | null; contract_missing: number | null; initial_by_att: Record<string, { cents: number | null; n: number | null } | null> | null; active_subs: number | null;
}

const SHOW_RATE_MIN_COVERAGE = 0.9;

/** The SQL's JSON carries null for an empty sum; the harness reads it as 0 (`n()`), so do the questions. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const EMPTY_MONEY: SqlMoney = { spend: null, initial_c: null, initial_n: null, recurring_c: null, collected: null, refunded_c: null, failed_n: null, mrr: null, contract_value: null, contract_missing: null, initial_by_att: null, active_subs: null };
/** The reporting currency's money block — empty (every sum null → 0) when the range has no money row at all. */
const cad = (S: SqlOut): SqlMoney => S.by_ccy?.CAD ?? EMPTY_MONEY;
const period = (S: SqlOut) => S.period ?? {};
const cohort = (S: SqlOut) => S.cohort ?? {};
const byAtt = (S: SqlOut) => S.enrolled_by_att ?? {};
const paidInitialCents = (S: SqlOut) => num(cad(S).initial_by_att?.paid?.cents);
const per = (spend: number, n: number): number | null => (spend > 0 && n > 0 ? Math.round(spend / n) : null);
const q = (range: EvalRangeKey, text: string) => `${text} ${RANGE_PHRASES[range]}? Lead with that one number.`;

/** A show rate as the harness computes it: showed ÷ (showed + no-show) when ≥ 90 % of past appointments have an outcome. */
export function showRateFromSql(S: SqlOut, type: 'Consult' | 'Roadmap'): number | null {
  const s = (S.show_rates ?? []).find((r) => r.type === type);
  if (!s) return null;
  const past = num(s.past);
  const showed = num(s.showed);
  const noShow = num(s.no_show);
  if (past === 0) return null;
  const decided = showed + noShow + num(s.cancelled);
  if (decided / past < SHOW_RATE_MIN_COVERAGE || showed + noShow === 0) return null;
  return showed / (showed + noShow);
}

export const NUMBERS_QUESTIONS: NumbersQuestion[] = [
  { id: 'n01', range: 'week', question: q('week', 'How many people applied'), metric: 'applied (in period)', unit: 'count', expected: (S) => num(period(S).applied) },
  { id: 'n02', range: 'week', question: q('week', 'How many consults were booked'), metric: 'consults booked (in period)', unit: 'count', expected: (S) => num(period(S).consult_booked) },
  { id: 'n03', range: 'week', question: q('week', 'How many roadmap calls were booked'), metric: 'roadmaps booked (in period)', unit: 'count', expected: (S) => num(period(S).roadmap_booked) },
  { id: 'n04', range: 'week', question: q('week', 'How many enrollments (GHL enrolled stage entries) did we get'), metric: 'enrollments', unit: 'count', expected: (S) => num(period(S).enrolled) },
  { id: 'n05', range: 'week', question: q('week', 'How much did we spend on ads, in the reporting currency,'), metric: 'spend', unit: 'cents', expected: (S) => num(cad(S).spend) },
  { id: 'n06', range: 'week', question: q('week', 'How much initial cash (new-client first payments) did we collect'), metric: 'initial cash', unit: 'cents', expected: (S) => num(cad(S).initial_c) },
  { id: 'n07', range: 'week', question: q('week', 'What was our Paid CAC'), metric: 'Paid CAC', unit: 'cents', expected: (S) => per(num(cad(S).spend), num(byAtt(S).paid)) },
  { id: 'n08', range: 'week', question: q('week', 'What was our Blended CAC'), metric: 'Blended CAC', unit: 'cents', expected: (S) => per(num(cad(S).spend), num(period(S).enrolled)) },
  { id: 'n09', range: 'month', question: q('month', 'How many people applied'), metric: 'applied (in period)', unit: 'count', expected: (S) => num(period(S).applied) },
  { id: 'n10', range: 'month', question: q('month', 'Of the people who applied, how many have booked a consult (by cohort)'), metric: 'consult booked (cohort)', unit: 'count', expected: (S) => num(cohort(S).consult_booked) },
  { id: 'n11', range: 'month', question: q('month', 'Of the people who applied, how many have booked a roadmap call (by cohort)'), metric: 'roadmap booked (cohort)', unit: 'count', expected: (S) => num(cohort(S).roadmap_booked) },
  { id: 'n12', range: 'month', question: q('month', 'Of the people who applied, how many have enrolled (by cohort)'), metric: 'enrolled (cohort)', unit: 'count', expected: (S) => num(cohort(S).enrolled) },
  { id: 'n13', range: 'month', question: q('month', 'How much did we spend on ads'), metric: 'spend', unit: 'cents', expected: (S) => num(cad(S).spend) },
  { id: 'n14', range: 'month', question: q('month', 'What was our ROAS'), metric: 'ROAS', unit: 'ratio', expected: (S) => (S.has_stripe && num(cad(S).spend) > 0 ? paidInitialCents(S) / num(cad(S).spend) : null) },
  { id: 'n15', range: 'month', question: q('month', 'How much recurring cash did we collect'), metric: 'recurring cash', unit: 'cents', expected: (S) => num(cad(S).recurring_c) },
  { id: 'n16', range: 'month', question: q('month', 'How much cash did we collect in total, net of refunds,'), metric: 'collected', unit: 'cents', expected: (S) => num(cad(S).collected) },
  { id: 'n17', range: 'month', question: q('month', 'How much was refunded'), metric: 'refunds', unit: 'cents', expected: (S) => num(cad(S).refunded_c) },
  { id: 'n18', range: 'month', question: q('month', 'How many payments failed'), metric: 'failed payments', unit: 'count', expected: (S) => num(cad(S).failed_n) },
  { id: 'n19', range: 'month', question: q('month', 'What was our cost per roadmap booked'), metric: 'cost per roadmap', unit: 'cents', expected: (S) => per(num(cad(S).spend), num(period(S).roadmap_booked)) },
  { id: 'n20', range: 'mtd', question: q('mtd', 'How many people applied'), metric: 'applied (in period)', unit: 'count', expected: (S) => num(period(S).applied) },
  { id: 'n21', range: 'mtd', question: q('mtd', 'How much have we spent on ads'), metric: 'spend', unit: 'cents', expected: (S) => num(cad(S).spend) },
  { id: 'n22', range: 'mtd', question: q('mtd', 'How much initial cash have we collected'), metric: 'initial cash', unit: 'cents', expected: (S) => num(cad(S).initial_c) },
  { id: 'n23', range: 'jul16', question: q('jul16', 'How many people applied'), metric: 'applied (in period)', unit: 'count', expected: (S) => num(period(S).applied) },
  { id: 'n24', range: 'jul16', question: q('jul16', 'How much have we spent on ads'), metric: 'spend', unit: 'cents', expected: (S) => num(cad(S).spend) },
  { id: 'n25', range: 'jul16', question: q('jul16', 'What is our consult show rate'), metric: 'consult show rate', unit: 'ratio', expected: (S) => showRateFromSql(S, 'Consult') },
];

export interface ExplainCase {
  id: string;
  metricKey: string;
  range: 'last_week' | 'last_month';
}

export const EXPLAIN_METRICS = ['initial_cash', 'enrollments', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'consults_booked', 'cost_roadmap', 'consult_show_rate', 'mrr'] as const;

export const EXPLAIN_CASES: ExplainCase[] = EXPLAIN_METRICS.flatMap((metricKey) => (['last_week', 'last_month'] as const).map((range) => ({ id: `e-${metricKey}-${range}`, metricKey, range })));

export type BehaviourKind = 'stale' | 'healthy' | 'clarify' | 'context' | 'campaign_row';

export interface BehaviourCase {
  id: string;
  kind: BehaviourKind;
  title: string;
  /** The turns, in order (one thread). */
  turns: Array<{ question: string; kind?: 'ask' | 'explain'; explainKey?: string; selected?: { kind: 'campaign'; id: string; label: string } }>;
}

export const BEHAVIOUR_CASES: BehaviourCase[] = [
  { id: 'b1', kind: 'stale', title: 'stale source → the warning first, every spend decision a hold', turns: [{ question: 'Which campaigns should we scale, hold or cut this week?' }] },
  { id: 'b2', kind: 'healthy', title: 'a healthy metric → no invented advice', turns: [{ question: '', kind: 'explain', explainKey: 'mrr' }] },
  { id: 'b3', kind: 'clarify', title: 'an ambiguous question → one clarifying question', turns: [{ question: 'Which one is better?' }] },
  {
    id: 'b4',
    kind: 'context',
    title: 'a 5-turn conversation keeps context ("that campaign")',
    turns: [
      { question: 'Which campaign had the best cost per client last week? Name it.' },
      { question: 'Why is that campaign doing well?' },
      { question: 'What did that campaign cost per client last week vs the week before?' },
      { question: 'Should we move budget to that campaign?' },
      { question: 'Summarise what you told me about that campaign in two sentences.' },
    ],
  },
  { id: 'b5', kind: 'campaign_row', title: 'opened from a campaign row → answers about that campaign', turns: [{ question: 'Why is this one worse?', selected: { kind: 'campaign', id: 'demo:summer-shred-retargeting', label: 'Summer Shred — Retargeting' } }] },
];
