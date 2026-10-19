/**
 * Every eval question's expected() is null-safe (2026-10-18): the SQL's `out` JSON is null wherever an aggregate had no
 * rows — no funnel row, no enrollment, no money row, no appointment. A null is "not available", never a crash.
 */
import { describe, it, expect } from 'vitest';
import { NUMBERS_QUESTIONS, showRateFromSql, type SqlOut } from '@/lib/analyst/evalQuestions';

const EMPTY: SqlOut = { period: null, cohort: null, has_stripe: false, enrolled_by_att: null, show_rates: null, by_ccy: null };
const SPARSE: SqlOut = { period: { applied: 3 }, cohort: {}, has_stripe: true, enrolled_by_att: null, show_rates: [{ type: 'Consult', past: 4, showed: null, no_show: null, cancelled: null }], by_ccy: { CAD: { spend: 12_000, initial_c: null, initial_n: null, recurring_c: null, collected: null, refunded_c: null, failed_n: null, mrr: null, contract_value: null, contract_missing: null, initial_by_att: null, active_subs: null }, USD: null } };

describe('eval questions on an empty week', () => {
  it('every question answers a number or null on an all-null JSON', () => {
    for (const q of NUMBERS_QUESTIONS) {
      const v = q.expected(EMPTY);
      expect(v === null || Number.isFinite(v), q.id).toBe(true);
    }
    expect(NUMBERS_QUESTIONS.find((q) => q.id === 'n07')!.expected(EMPTY)).toBeNull();
    expect(NUMBERS_QUESTIONS.find((q) => q.id === 'n01')!.expected(EMPTY)).toBe(0);
    expect(showRateFromSql(EMPTY, 'Consult')).toBeNull();
  });
  it('spend with no enrollment: Paid CAC and Blended CAC are null, spend is the number, ROAS is 0 with Stripe rows and no paid cash', () => {
    const by = (id: string) => NUMBERS_QUESTIONS.find((q) => q.id === id)!.expected(SPARSE);
    expect(by('n05')).toBe(12_000);
    expect(by('n07')).toBeNull();
    expect(by('n08')).toBeNull();
    expect(by('n14')).toBe(0);
    expect(by('n01')).toBe(3);
    expect(showRateFromSql(SPARSE, 'Consult')).toBeNull(); // 0 of 4 decided → under the 90 % coverage
  });
});
