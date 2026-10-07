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
