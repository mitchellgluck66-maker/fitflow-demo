/**
 * Spend decision gates (Oct 7 item 1): computed by code over the CLEAN trailing weeks, per campaign and for the
 * account; may_change only with ≥ 4 tracked enrollments over ≥ 4 weeks with spend; every other case holds with
 * what is missing; stale data holds everything; a pre-history catch-up week never counts.
 */
import { describe, it, expect } from 'vitest';
import { computeSpendGates, gateFor, gateForAction, gatesLine, holdForStale, SPEND_GATE, SPEND_GATE_RULE } from '@/lib/metrics/spendGate';
import { cleanBaseline } from '@/lib/metrics/baseline';
import { glossaryEntry } from '@/lib/metrics/glossary';
import { weekBuckets } from '@/lib/dates';
import type { MetricsInput } from '@/lib/metrics';

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const WEEKS = weekBuckets('2026-08-02', '2026-09-26'); // 8 Sun–Sat weeks

/** Per week: spend per campaign and enrolled contacts per campaign. */
function inputWith(spec: Array<{ week: number; spend?: Record<string, number>; enrolled?: Record<string, number> }>, weeks = WEEKS): MetricsInput {
  const input: MetricsInput = { contacts: [], transitions: [], appointments: [], spend: [], payments: [] };
  let n = 0;
  for (const s of spec) {
    const w = weeks[s.week];
    for (const [campaign, cents] of Object.entries(s.spend ?? {})) input.spend.push({ date: w.start, platform: 'meta', currency: 'CAD', spendCents: cents, origin: 'meta', level: 'campaign', campaignId: campaign.toLowerCase(), campaignName: campaign, impressions: 100, clicks: 10 });
    for (const [campaign, count] of Object.entries(s.enrolled ?? {})) {
      for (let k = 0; k < count; k++) {
        n += 1;
        const day = w.start.slice(0, 8) + String(Number(w.start.slice(8)) + 2).padStart(2, '0');
        input.contacts.push({ id: `c${n}`, name: `P${n}`, email: null, source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: w.start, monetaryValueCents: 0, origin: 'ghl', campaign, attribution: 'paid' });
        input.transitions.push({ contactId: `c${n}`, fromRole: 'roadmap_booked', toRole: 'enrolled', toStageId: null, on: day, atMs: noon(day) });
      }
    }
  }
  return input;
}

describe('gateFor — the thresholds', () => {
  const base = { campaign: 'Broad', platform: 'meta', weeksInWindow: 8, spendCents: 100_000, currency: 'CAD' as const };
  it('may_change only with ≥ 4 enrollments AND ≥ 4 weeks with spend; the basis is a phrase, the reason a sentence', () => {
    expect(SPEND_GATE).toEqual({ minEnrollments: 4, minWeeks: 4 });
    expect(gateFor({ ...base, trackedEnrollments: 4, weeksWithSpend: 4 })).toMatchObject({ decision: 'may_change', basis: '4 tracked enrollments over 4 weeks with spend', needsEnrollments: 0, needsWeeks: 0 });
    expect(gateFor({ ...base, trackedEnrollments: 2, weeksWithSpend: 3 })).toMatchObject({ decision: 'hold', basis: '2 of 4 tracked enrollments, 3 of 4 weeks with spend', reason: 'hold — insufficient sample: needs 2 more tracked enrollments (2 of 4) and 1 more complete week with spend (3 of 4)', needsEnrollments: 2, needsWeeks: 1 });
    expect(gateFor({ ...base, trackedEnrollments: 9, weeksWithSpend: 3 })).toMatchObject({ decision: 'hold', reason: 'hold — insufficient sample: needs 1 more complete week with spend (3 of 4)' });
    expect(gateFor({ ...base, trackedEnrollments: 3, weeksWithSpend: 8 })).toMatchObject({ decision: 'hold', reason: 'hold — insufficient sample: needs 1 more tracked enrollment (3 of 4)' });
    expect(gateFor({ ...base, trackedEnrollments: 0, weeksWithSpend: 0, spendCents: 0 })).toMatchObject({ decision: 'hold', basis: 'no spend in the window' });
    expect(gateFor({ ...base, trackedEnrollments: 9, weeksWithSpend: 2, weeksInWindow: 2, windowNote: 'baseline needs 4 complete weeks of complete stage history; have 2' })).toMatchObject({ decision: 'hold', basis: 'window too short: 2 of 4 clean weeks' });
    expect(SPEND_GATE_RULE).toContain('≥ 4 tracked enrollments over ≥ 4 complete weeks');
  });
});

describe('computeSpendGates over the clean window', () => {
  it('sums per campaign and for the account; a campaign with no spend is not listed; names normalise; the line and the lookup', () => {
    const input = inputWith([
      { week: 0, spend: { Broad: 50_000, Retarget: 10_000 }, enrolled: { Broad: 1 } },
      { week: 1, spend: { Broad: 50_000 }, enrolled: { Broad: 1 } },
      { week: 2, spend: { Broad: 50_000, Retarget: 10_000 }, enrolled: { Broad: 1, Retarget: 1 } },
      { week: 3, spend: { Broad: 50_000 }, enrolled: { Broad: 1 } },
      { week: 4, spend: { Broad: 50_000, Retarget: 10_000 }, enrolled: { Retarget: 1 } },
      { week: 5, enrolled: { Organic: 2 } },
    ]);
    const g = computeSpendGates(input, WEEKS);
    expect(g.window).toEqual({ start: '2026-08-02', end: '2026-09-26', weeksUsed: 8, note: null });
    expect(g.campaigns.map((c) => [c.campaign, c.decision, c.trackedEnrollments, c.weeksWithSpend, c.spendCents])).toEqual([
      ['Broad', 'may_change', 4, 5, 250_000],
      ['Retarget', 'hold', 2, 3, 30_000],
    ]);
    expect(g.campaigns[1]).toMatchObject({ basis: '2 of 4 tracked enrollments, 3 of 4 weeks with spend', platform: 'meta', currency: 'CAD' });
    // The account: every tracked enrollment of a spending campaign (organic enrollments carry no campaign spend and are not tracked) over the weeks anything spent.
    expect(g.account).toMatchObject({ campaign: 'account', decision: 'may_change', trackedEnrollments: 6, weeksWithSpend: 5, spendCents: 280_000 });
    expect(gateForAction(g, 'retarget')?.decision).toBe('hold');
    expect(gateForAction(g, 'account')?.campaign).toBe('account');
    expect(gateForAction(g, '')?.campaign).toBe('account');
    expect(gateForAction(g, 'Nope')).toBeNull();
    expect(gatesLine(g)).toBe('spend gates: account may change (6 tracked enrollments over 5 weeks with spend) · Broad may change (4 tracked enrollments over 5 weeks with spend) · Retarget hold (2 of 4 tracked enrollments, 3 of 4 weeks with spend)');
    const stale = holdForStale(g, 'Meta Ads spend stale for 9.0 h');
    expect(stale.account).toMatchObject({ decision: 'hold', basis: 'data stale: Meta Ads spend stale for 9.0 h' });
    expect(stale.campaigns.every((c) => c.decision === 'hold')).toBe(true);
  });
  it('a pre-history catch-up week is excluded from the window: 12 enrolled entries in it open no gate', () => {
    const input = inputWith([{ week: 0, spend: { Broad: 50_000 }, enrolled: { Broad: 12 } }, { week: 4, spend: { Broad: 50_000 }, enrolled: { Broad: 1 } }, { week: 5, spend: { Broad: 50_000 } }, { week: 6, spend: { Broad: 50_000 } }, { week: 7, spend: { Broad: 50_000 } }]);
    const dirty = computeSpendGates(input, WEEKS);
    expect(dirty.campaigns[0]).toMatchObject({ decision: 'may_change', trackedEnrollments: 13, weeksWithSpend: 5 });
    const clean = cleanBaseline({ candidate: WEEKS, metric: 'enrollments', historyCompleteSince: '2026-08-30', today: '2026-10-06' });
    expect(clean.weeks.length).toBe(4);
    const gated = computeSpendGates(input, clean.weeks, clean.enough ? null : clean.note);
    expect(gated.campaigns[0]).toMatchObject({ decision: 'hold', trackedEnrollments: 1, weeksWithSpend: 4, reason: 'hold — insufficient sample: needs 3 more tracked enrollments (1 of 4)' });
    const short = cleanBaseline({ candidate: WEEKS.slice(-3), metric: 'enrollments', historyCompleteSince: '2026-08-30', today: '2026-10-06' });
    expect(computeSpendGates(input, short.weeks, short.enough ? null : short.note).campaigns[0]).toMatchObject({ decision: 'hold', basis: 'window too short: 3 of 4 clean weeks' });
  });
  it('the glossary entry states the rule and works the account gate', () => {
    const e = glossaryEntry('spend_gate')!;
    expect(e.definition).toContain(SPEND_GATE_RULE);
    expect(e.maturing).toBe(true);
    // worked() has no settings: the default history-complete date (2026-09-01) excludes the August weeks, so the window is Sep 6 – Oct 3 (4 clean weeks).
    const later = weekBuckets('2026-08-09', '2026-10-03');
    const input = inputWith([0, 1, 2, 3, 4, 5, 6, 7].map((week) => ({ week, spend: { Broad: 50_000 }, enrolled: { Broad: 1 } })), later);
    const w = e.worked(input, { start: '2026-10-04', end: '2026-10-10' });
    expect(w).toMatchObject({ value: 1, inputs: { trackedEnrollments: 4, weeksWithSpend: 4, mayChange: 1, campaigns: 1 } });
    expect(w.text).toContain('1 of 1 campaigns may change');
  });
});
