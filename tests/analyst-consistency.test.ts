/**
 * 1d (2026-10-06): the same question on the same data gives the same verdict and the same headline figures.
 * The starter snapshot (r1 data health, r2 last week's scorecard) is built twice on the seeded demo tenant and
 * must be byte-identical apart from nothing — the verdict is computed by code (lib/metrics/verdict.ts), so two
 * live runs can only disagree if the model ignores it, which the smoke now fails ("headline verdict ≠ computed").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { runStarterCalls, STARTER_CALLS } from '@/lib/analyst/starter';
import { ANALYST_TOOLS, type Freshness } from '@/lib/analyst/tools';
import { Ledger } from '@/lib/analyst/ledger';
import { verifyAnswer } from '@/lib/analyst/verify';
import { applySpendDecisions, spendDecisionsLine } from '@/lib/analyst/spendDecisions';
import type { Answer } from '@/lib/analyst/schema';
import { getScorecard } from '@/lib/metrics/service';
import { computeWeekVerdict } from '@/lib/metrics/verdict';
import { loadMetricsInput } from '@/lib/metrics/load';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone, rangeFromParams } from '@/lib/dates';

const freshness: Freshness = { stale: false, line: 'data fresh — test', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] };

describe('same data → same snapshot, same verdict', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);

  it('the starter snapshot built twice is identical: verdict, baselines, every KPI', async () => {
    const a = await runStarterCalls(freshness, ANALYST_TOOLS, STARTER_CALLS);
    const b = await runStarterCalls(freshness, ANALYST_TOOLS, STARTER_CALLS);
    expect(a.map((r) => r.ref)).toEqual(['r1', 'r2']);
    for (let i = 0; i < a.length; i++) expect(JSON.stringify(a[i].result.data), a[i].name).toBe(JSON.stringify(b[i].result.data));
    const r2 = a[1].result.data as { verdict: { verdict: string; reason: string; basisClients: string | null }; kpis: Record<string, { current: number | null }>; baseline: { enrollmentsPerWeek: number | null; newPayingClientsPerWeek: number | null } };
    expect(['strong', 'normal', 'weak', 'unavailable']).toContain(r2.verdict.verdict);
    // Oct 7 item 4: the reason never restates the verdict word; the basis phrase is the citeable text.
    expect(r2.verdict.reason.startsWith(`${r2.verdict.verdict}`)).toBe(false);
    expect(r2.verdict.basisClients).toMatch(/^\d+ new paying clients? vs /);
    expect(r2.verdict.verdict).not.toBe('unavailable'); // the demo tenant has Stripe-dated payments and 8 complete weeks
    expect(r2.baseline.newPayingClientsPerWeek).not.toBeNull();
  });

  it('Oct 7 item 1 + Wave 2 tune-up 1: the spend gates are identical across two builds and the server\'s spend decisions are the same line both times', async () => {
    const res1 = await getScorecard({ range: 'last_week', compare: 'previous_period' });
    const res2 = await getScorecard({ range: 'last_week', compare: 'previous_period' });
    expect(res1.spendGates).toEqual(res2.spendGates);
    expect(['may_change', 'hold']).toContain(res1.spendGates.account.decision);
    expect(res1.spendGates.campaigns.length).toBeGreaterThan(0);
    for (const g of [res1.spendGates.account, ...res1.spendGates.campaigns]) expect(g.decision === 'may_change' ? g.trackedEnrollments >= 4 && g.weeksWithSpend >= 4 : g.trackedEnrollments < 4 || g.weeksWithSpend < 4 || g.spendCents === 0, `${g.campaign}: ${g.reason}`).toBe(true);
    // The same canned answer (an increase on EVERY gate) decided twice against two snapshots: the same decisions, the
    // same `spend:` line, and the server-written holds verify with nothing flagged — by construction.
    const snap = await runStarterCalls(freshness, ANALYST_TOOLS, STARTER_CALLS);
    const outcomes = [snap, await runStarterCalls(freshness, ANALYST_TOOLS, STARTER_CALLS)].map((results) => {
      const ledger = new Ledger();
      for (const r of results) ledger.add(r.ref, r.result.data, '2026-10-07T00:00:00.000Z', r.result.currency);
      const actions = [res1.spendGates.account, ...res1.spendGates.campaigns].map((g) => ({ action: `Increase ${g.campaign}`, why: 'x', owner: 'Jake', kind: 'spend' as const, campaign: g.campaign, spend_change: 'increase' as const, expected_impact: 'unknown', confidence: 'low' as const, metric: 'paid_cac', check_date: '2026-10-14' }));
      const answer: Answer = { kind: 'answer', headline: { text: 'x' }, sections: [{ key: 'do_this', body_md: 'y' }], actions, findings: [], note_proposals: [], clarifying_question: '' };
      const decided = applySpendDecisions(answer, ledger, { stale: false, checkDate: '2026-10-22' });
      return { line: spendDecisionsLine(decided.decisions), decisions: decided.decisions, flagged: verifyAnswer(decided.answer, ledger).flagged };
    });
    expect(outcomes[0].line).toBe(outcomes[1].line);
    expect(outcomes[0].decisions).toEqual(outcomes[1].decisions);
    expect(outcomes[0].flagged).toEqual([]);
    const gates = [res1.spendGates.account, ...res1.spendGates.campaigns];
    expect(outcomes[0].decisions.map((d) => d.campaign)).toEqual(gates.map((g) => g.campaign)); // one decision per gate row, in gate order
    for (const d of outcomes[0].decisions) expect(d.gate === 'hold' ? d.decision === 'hold' && d.decidedBy === 'server' : d.decision === 'increase' && d.decidedBy === 'model', d.campaign).toBe(true);
  });

  it('the verdict is a pure function of the input: twice from the same rows, and equal to the scorecard route', async () => {
    const tz = await getTimezone();
    const today = todayInTimezone(tz);
    const week = rangeFromParams({ range: 'last_week' }, today);
    const res1 = await getScorecard({ range: 'last_week', compare: 'previous_period' });
    const res2 = await getScorecard({ range: 'last_week', compare: 'previous_period' });
    expect(res1.verdict).toEqual(res2.verdict);
    const input = await loadMetricsInput({ start: res1.baseline.start, end: week.end, timezone: tz });
    const direct = computeWeekVerdict(input, { start: week.start, end: week.end }, res1.baselines.sourceDated);
    expect(direct).toEqual(res1.verdict);
    expect(JSON.stringify(res1.scorecard.kpis)).toBe(JSON.stringify(res2.scorecard.kpis));
  });
});
