/**
 * The week verdict (1b, 2026-10-06): decided by CODE from Stripe first payments and new-client cash against the
 * clean baseline, with the thresholds the glossary states — never by the model. Every edge of the rule, the
 * unavailable cases, the sentence, the weekly-only range rule, and the smoke's headline check.
 */
import { describe, it, expect } from 'vitest';
import { computeWeekVerdict, weekVerdictFor, VERDICT_RULE, VERDICT_THRESHOLDS } from '@/lib/metrics/verdict';
import { cleanBaseline, trailingBaseline } from '@/lib/metrics/baseline';
import { glossaryEntry } from '@/lib/metrics/glossary';
import { starterVerdict, verdictMiss } from '@/lib/analyst/smoke';
import type { MetricsInput, PaymentRow } from '@/lib/metrics';
import { SNAPSHOT_PREFIX } from '@/lib/analyst/starter';

/** Build an input where each listed week has N first payments of `cents`. */
function inputWith(weeks: Array<{ start: string; clients: number; cents?: number }>): MetricsInput {
  const payments: PaymentRow[] = [];
  let n = 0;
  for (const w of weeks) {
    for (let k = 0; k < w.clients; k++) {
      n += 1;
      const day = `${w.start.slice(0, 8)}${String(Number(w.start.slice(8)) + 1 + (k % 5)).padStart(2, '0')}`;
      payments.push({ id: `p${n}`, stripeId: `ch_${n}`, contactId: `c${n}`, kind: 'charge', currency: 'CAD', amountCents: w.cents ?? 300_000, refundedCents: 0, status: 'succeeded', on: day, origin: 'stripe', paymentClass: 'initial' });
    }
  }
  return { contacts: [], transitions: [], appointments: [], spend: [], payments };
}
const BASE_WEEKS = ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'];
const LAST = { start: '2026-09-27', end: '2026-10-03' };
const baseline = trailingBaseline({ before: LAST.start, metric: 'initial_cash', today: '2026-10-06' });
const withWeek = (clients: number, cents = 300_000, basePerWeek = 4) => inputWith([...BASE_WEEKS.map((start) => ({ start, clients: basePerWeek })), { start: LAST.start, clients, cents }]);

describe('computeWeekVerdict — the rule', () => {
  it('normal: 4 new paying clients vs 4/week; the sentence carries both ratios', () => {
    const v = computeWeekVerdict(withWeek(4), LAST, baseline);
    expect(v).toMatchObject({ verdict: 'normal', clients: 4, cashCents: 1_200_000, baselineClientsPerWeek: 4, baselineCashPerWeekCents: 1_200_000, ratioClients: 1, ratioCash: 1, weeksUsed: 8, currency: 'CAD' });
    // Oct 7 item 4: the reason never restates the verdict word; the basis phrases are the citeable text refs.
    expect(v.reason).toBe('4 new paying clients vs 4/week over 8 weeks (1.00×); $12,000 CAD new-client cash vs $12,000 CAD/week (1.00×)');
    expect(v.basisClients).toBe('4 new paying clients vs 4/week over 8 weeks (1.00×)');
    expect(v.basisCash).toBe('$12,000 CAD new-client cash vs $12,000 CAD/week (1.00×)');
    expect(v.rule).toBe(VERDICT_RULE);
  });
  it('strong at the 1.3× edge on clients with cash ≥ 1.0×, or on cash with clients ≥ 1.0×; not when the other side is below 1.0×', () => {
    expect(computeWeekVerdict(withWeek(6), LAST, baseline).verdict).toBe('strong'); // 1.5× clients, 1.5× cash
    expect(computeWeekVerdict(withWeek(5), LAST, baseline).verdict).toBe('normal'); // 1.25× — under the edge
    expect(computeWeekVerdict(withWeek(4, 400_000), LAST, baseline).verdict).toBe('strong'); // clients 1.0×, cash 1.33×
    expect(computeWeekVerdict(withWeek(6, 150_000), LAST, baseline).verdict).toBe('normal'); // clients 1.5× but cash 0.75×
    expect(VERDICT_THRESHOLDS).toEqual({ strong: 1.3, weak: 0.7, minWeeks: 4 });
  });
  it('weak at the 0.7× edge on clients with cash ≤ 1.0×, or on cash with clients ≤ 1.0×', () => {
    expect(computeWeekVerdict(withWeek(2), LAST, baseline).verdict).toBe('weak'); // 0.5× both
    expect(computeWeekVerdict(withWeek(3), LAST, baseline).verdict).toBe('normal'); // 0.75×
    expect(computeWeekVerdict(withWeek(4, 200_000), LAST, baseline).verdict).toBe('weak'); // clients 1.0×, cash 0.67×
    expect(computeWeekVerdict(withWeek(2, 700_000), LAST, baseline).verdict).toBe('normal'); // clients 0.5× but cash 1.17×
  });
  it('the Oct 4 case: 4 Stripe-confirmed new clients vs 4.25/week is normal — whatever GHL "enrolled" says', () => {
    const base = ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'].map((start, i) => ({ start, clients: [6, 3, 1, 5, 4, 4, 5, 6][i] }));
    const v = computeWeekVerdict(inputWith([...base, { start: LAST.start, clients: 4 }]), LAST, baseline);
    expect(v).toMatchObject({ verdict: 'normal', clients: 4, baselineClientsPerWeek: 4.25, ratioClients: 0.94 });
  });
  it('unavailable: Stripe not connected, fewer than 4 baseline weeks, or a zero baseline — each with its reason', () => {
    const noStripe = computeWeekVerdict({ ...withWeek(4), payments: [] }, LAST, baseline);
    expect(noStripe).toMatchObject({ verdict: 'unavailable', reason: 'Stripe is not connected — new clients are counted from first payments', clients: null, basisClients: null, basisCash: null });
    const short = cleanBaseline({ candidate: baseline.candidate.slice(-2), metric: 'initial_cash', today: '2026-10-06' });
    expect(computeWeekVerdict(withWeek(4), LAST, short)).toMatchObject({ verdict: 'unavailable', reason: 'baseline needs 4 complete weeks; have 2 (Sep 13–26)', clients: 4 });
    expect(computeWeekVerdict(withWeek(4, 300_000, 0), LAST, baseline)).toMatchObject({ verdict: 'unavailable', reason: 'the 8-week baseline has no new paying clients to compare against', baselineClientsPerWeek: 0 });
  });
  it('weekVerdictFor: only exactly one Sun–Sat week gets a verdict; the glossary entry states the rule and works the formula', () => {
    expect(weekVerdictFor(withWeek(4), { start: '2026-09-01', end: '2026-09-30' }, baseline)).toMatchObject({ verdict: 'unavailable', reason: expect.stringMatching(/^the verdict is weekly/) });
    expect(weekVerdictFor(withWeek(4), LAST, baseline).verdict).toBe('normal');
    const e = glossaryEntry('week_verdict')!;
    expect(e.definition).toContain(VERDICT_RULE);
    expect(e.worked(withWeek(6), LAST)).toMatchObject({ value: 6, reason: null, inputs: { clients: 6, baselineClientsPerWeek: 4, ratioClients: 1.5 } });
    expect(e.worked(withWeek(6), { start: '2026-09-01', end: '2026-09-30' })).toMatchObject({ value: null, reason: expect.stringMatching(/^the verdict is weekly/) });
  });
});

describe('the smoke holds the headline to the computed verdict', () => {
  const row = (verdict: string) => ({ apiJson: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Snapshot…' }, { type: 'text', text: `${SNAPSHOT_PREFIX}${JSON.stringify({ ref: 'r2', data: { verdict: { verdict, reason: `${verdict}: …` } } })}` }, { type: 'text', text: 'q' }] }) });
  it('reads r2 from the starter row; a headline with another verdict word (or none) is a miss', () => {
    expect(starterVerdict([row('normal')])).toEqual({ verdict: 'normal', reason: 'normal: …' });
    expect(starterVerdict(null)).toBeNull();
    expect(verdictMiss({ verdict: 'normal' }, 'A normal week: 4 new clients.')).toBeNull();
    expect(verdictMiss({ verdict: 'normal' }, 'A STRONG week — double your normal.')).toBeNull(); // both words present: the server's is there
    expect(verdictMiss({ verdict: 'normal' }, 'A strong week — double the usual.')).toBe('headline verdict ≠ computed verdict: the headline says "strong", the server computed normal');
    expect(verdictMiss({ verdict: 'weak' }, 'Enrollments doubled.')).toBe('headline verdict ≠ computed verdict: the headline says "(no verdict word)", the server computed weak');
    expect(verdictMiss({ verdict: 'unavailable' }, 'A strong week.')).toMatch(/the server computed unavailable/);
    expect(verdictMiss({ verdict: 'unavailable' }, 'Stripe is not connected, so no verdict.')).toBeNull();
    expect(verdictMiss(null, 'anything')).toBeNull();
  });
});
