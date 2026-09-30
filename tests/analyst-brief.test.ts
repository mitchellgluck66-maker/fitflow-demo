/**
 * The business brief (Analyst plan item 3 + amendments 2 and 4): every weekly
 * number equals the engine for that week; maturing weeks are flagged and the
 * baselines say how many they include; the same data gives the same hash; a
 * proposed note never reaches the brief until approved; the dispatch step is
 * once per local day.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { computeScorecard, type ContactRow, type MetricsInput, type PaymentRow } from '@/lib/metrics';
import { buildBrief, DECISIONS_LOG } from '@/lib/analyst/brief';
import { EMPTY_PROFILE, parseOwnerProfile, profileGaps, withheldLine, addNote, decideNote, listNotes, activeNotes, saveOwnerProfile, getOwnerProfile } from '@/lib/analyst/notes';
import { currentBrief, describeBrief, rebuildBrief, runAnalystBriefStep } from '@/lib/analyst/briefService';
import { runMigrations } from '@/db/migrate';
import { weekBuckets } from '@/lib/dates';

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const c = (id: string, attribution: 'paid' | 'organic', valueCents: number, appliedOn: string): ContactRow => ({ id, name: id.toUpperCase(), email: null, source: 'Facebook', stageId: 's', stageName: 'Enrolled', role: 'enrolled', appliedOn, monetaryValueCents: valueCents, origin: 'ghl', attribution, campaign: 'Summer Shred' });
const t = (contactId: string, fromRole: string | null, toRole: string, on: string) => ({ contactId, fromRole: fromRole as never, toRole: toRole as never, toStageId: `st-${toRole}`, on, atMs: noon(on) });
const pay = (id: string, contactId: string, cents: number, on: string): PaymentRow => ({ id, stripeId: id, contactId, kind: 'charge', currency: 'CAD', amountCents: cents, refundedCents: 0, status: 'succeeded', on, origin: 'stripe', paymentClass: 'initial' });

// First data Aug 2 (Sunday); today Sep 16 (Wednesday) → 6 complete weeks + the week to date. History complete from Sep 1.
const FIRST = '2026-08-02';
const TODAY = '2026-09-16';
const INPUT: MetricsInput = {
  contacts: [c('a', 'paid', 500_000, '2026-08-03'), c('b', 'organic', 400_000, '2026-08-11'), c('d', 'paid', 600_000, '2026-09-02'), c('e', 'paid', 0, '2026-09-14')],
  transitions: [
    t('a', 'applied', 'consult_booked', '2026-08-04'), t('a', 'consult_booked', 'roadmap_booked', '2026-08-06'), t('a', 'roadmap_booked', 'enrolled', '2026-08-08'),
    t('b', 'applied', 'consult_booked', '2026-08-12'), t('b', 'consult_booked', 'enrolled', '2026-08-20'),
    t('d', 'applied', 'consult_booked', '2026-09-03'), t('d', 'consult_booked', 'roadmap_booked', '2026-09-04'), t('d', 'roadmap_booked', 'enrolled', '2026-09-05'),
    t('e', 'applied', 'consult_booked', '2026-09-15'),
  ],
  appointments: [],
  spend: [
    { date: '2026-08-03', platform: 'meta', currency: 'CAD', spendCents: 50_000, origin: 'meta', level: 'campaign', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 1000, linkClicks: 40 },
    { date: '2026-08-12', platform: 'meta', currency: 'CAD', spendCents: 30_000, origin: 'meta', level: 'campaign', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 800, linkClicks: 30 },
    { date: '2026-09-02', platform: 'meta', currency: 'CAD', spendCents: 70_000, origin: 'meta', level: 'campaign', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 1500, linkClicks: 60 },
  ],
  payments: [pay('p-a', 'a', 250_000, '2026-08-08'), pay('p-b', 'b', 200_000, '2026-08-20'), pay('p-d', 'd', 300_000, '2026-09-05')],
};

const base = { timezone: 'America/Edmonton', today: TODAY, input: INPUT, firstData: FIRST, historyCompleteSince: '2026-09-01', disclaimerSunset: '2026-10-15', profile: EMPTY_PROFILE, notes: [] };

describe('buildBrief (pure)', () => {
  const brief = buildBrief(base);

  it('has one row per Sun–Sat week since the first data, the last one week to date, and every number equals computeScorecard for that week', () => {
    const weeks = weekBuckets(FIRST, TODAY);
    expect(brief.weeks.length).toBe(weeks.length);
    expect(brief.weeks[brief.weeks.length - 1].partial).toBe(true);
    for (const w of brief.weeks) {
      const sc = computeScorecard(INPUT, w, null, null);
      expect(w.applied).toBe(sc.kpis.applied.current);
      expect(w.consultsBooked).toBe(sc.kpis.consultsBooked.current);
      expect(w.roadmapsBooked).toBe(sc.kpis.roadmapsBooked.current);
      expect(w.enrolled).toBe(sc.kpis.enrollments.current);
      expect(w.spendCents).toBe(sc.marketing.spendCents);
      expect(w.paidCacCents).toBe(sc.marketing.paidCacCents);
      expect(w.blendedCacCents).toBe(sc.marketing.blendedCacCents);
      expect(w.roas).toBe(sc.marketing.roas);
      expect(w.initialCents).toBe(sc.revenue.initialCents);
    }
    // Aug 2–8: a applied, booked, roadmap, enrolled; $500 spend; $2,500 initial cash; Paid CAC $500.
    const aug2 = brief.weeks[0];
    expect(aug2).toMatchObject({ applied: 1, consultsBooked: 1, roadmapsBooked: 1, enrolled: 1, spendCents: 50_000, initialCents: 250_000, paidCacCents: 50_000 });
    expect(brief.text).toContain('Aug 2–8 | 1 | 1 | 1 | 1 | $2,500 CAD | $0 CAD | $500 CAD | $500 CAD | $500 CAD | 5.00× | maturing');
  });

  it('amendment 2: weeks before history_complete_since are maturing; the baselines say how many they include', () => {
    // A week that STARTS before the history-complete date is maturing (Aug 30 – Sep 5 included), same rule as the badge.
    expect(brief.weeks.filter((w) => w.maturing).map((w) => w.start)).toEqual(['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30']);
    expect(brief.weeks.filter((w) => !w.maturing).map((w) => w.start)).toEqual(['2026-09-06', '2026-09-13']);
    expect(brief.text).toContain('Maturing weeks: Aug 2–8; Aug 9–15; Aug 16–22; Aug 23–29; Aug 30 – Sep 5.');
    expect(brief.text).toMatch(/Trailing 8 weeks \(Aug 2 – Sep 12, 6 weeks\).*Includes 5 maturing weeks/);
    // After the sunset nothing is maturing and the text says so.
    const after = buildBrief({ ...base, today: '2026-10-20' });
    expect(after.weeks.some((w) => w.maturing)).toBe(false);
    expect(after.text).toContain('No maturing weeks');
  });

  it('carries no build time: the same inputs give the same hash; a note or a profile change gives a new one', () => {
    expect(buildBrief(base).hash).toBe(brief.hash);
    expect(brief.text).not.toMatch(/built at|\d{2}:\d{2}:\d{2}/);
    const withNote = buildBrief({ ...base, notes: [{ text: 'August had a price change', createdAt: '2026-08-15T10:00:00Z' }] });
    expect(withNote.hash).not.toBe(brief.hash);
    expect(withNote.text).toContain('- 2026-08-15: August had a price change');
    const withProfile = buildBrief({ ...base, profile: { ...EMPTY_PROFILE, grossMarginPct: 70 } });
    expect(withProfile.hash).not.toBe(brief.hash);
  });

  it('amendment 4: profile gaps are named with the metrics they withhold; a full profile has none', () => {
    expect(brief.text).toContain('Withheld until filled: CAC payback, pace to target, funnel-leak $');
    expect(brief.text).toContain('Name the missing field instead of estimating');
    const full = { ...EMPTY_PROFILE, grossMarginPct: 70, monthlyRevenueTargetCents: 5_000_000, offers: [{ name: '12-week program', priceCents: 500_000, currency: 'CAD' as const }] };
    expect(profileGaps(full)).toEqual([]);
    expect(withheldLine(profileGaps(full))).toBeNull();
    expect(buildBrief({ ...base, profile: full }).text).not.toContain('Withheld until filled');
    expect(profileGaps({ ...full, grossMarginPct: 0 }).map((g) => g.withheld)).toEqual(['CAC payback']);
  });

  it('includes the decisions log, the glossary, conversions in both modes, campaigns and revenue by month', () => {
    for (const d of DECISIONS_LOG) expect(brief.text).toContain(`- ${d.id}: `);
    expect(brief.text).toContain('## Metric glossary');
    expect(brief.text).toContain('(paid_cac)');
    expect(brief.text).toContain('Aug 2–8 | cohort | 100.0% | 100.0% | 100.0% | 100.0% | maturing');
    expect(brief.text).toContain('Aug 2–8 | Summer Shred | meta | $500 CAD | 1000 | 40 | 1 | 1 | $2,500 CAD | 5.00×');
    expect(brief.text).toContain('2026-08 | $4,500 CAD | $0 CAD | $4,500 CAD | $0 CAD | 0');
    expect(brief.text).toContain('2026-09 (month to date) |');
    expect(brief.text).toContain('This brief orients you. It is NOT citeable');
  });

  it('parseOwnerProfile is defensive', () => {
    expect(parseOwnerProfile(null)).toEqual(EMPTY_PROFILE);
    expect(parseOwnerProfile('not json')).toEqual(EMPTY_PROFILE);
    expect(parseOwnerProfile(JSON.stringify({ goals: 'g', grossMarginPct: '70', offers: [{ name: 'x', priceCents: 100.4 }, { name: '' }] }))).toEqual({ ...EMPTY_PROFILE, goals: 'g', offers: [{ name: 'x', priceCents: 100, currency: 'CAD' }] });
  });
});

describe('notes and the stored brief (PGlite)', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it('an owner note is active at once; an Analyst proposal is proposed and never reaches the brief until approved', async () => {
    const owner = await addNote('Price rose to $5,000 on Aug 1', { source: 'owner' });
    const proposal = await addNote('The Analyst thinks Tuesdays are slow', { source: 'analyst', threadId: 'thread-1' });
    expect(owner.status).toBe('active');
    expect(proposal.status).toBe('proposed');
    expect((await activeNotes()).map((n) => n.id)).toEqual([owner.id]);

    const first = await rebuildBrief({ trigger: 'manual', countTokens: false });
    expect(first.ok).toBe(true);
    expect(first.tokenCountError).toBe('not counted — skipped');
    const stored = await currentBrief();
    expect(stored?.text).toContain('Price rose to $5,000 on Aug 1');
    expect(stored?.text).not.toContain('Tuesdays are slow');

    expect(await decideNote(proposal.id, 'active')).toMatchObject({ status: 'active' });
    expect(await decideNote(proposal.id, 'rejected')).toBeNull(); // only proposed rows can be decided
    const second = await rebuildBrief({ trigger: 'notes', countTokens: false });
    expect(second.hash).not.toBe(first.hash);
    expect((await currentBrief())?.text).toContain('Tuesdays are slow');
    expect((await listNotes()).length).toBe(2);
  });

  it('the dispatch step builds once per local day and says so; the description reads as Setup shows it', async () => {
    const step = await runAnalystBriefStep();
    expect(step).toMatchObject({ skipped: expect.stringMatching(/^brief already built today at \d{2}:\d{2} \(tokens not counted\)$/) });
    const forced = await runAnalystBriefStep({ force: true });
    expect(forced).toMatchObject({ ok: true, unchanged: true });
    expect(describeBrief(await currentBrief(), 'America/Edmonton')).toMatch(/^Brief built \d{4}-\d{2}-\d{2} \d{2}:\d{2} · tokens not counted · data through \d{4}-\d{2}-\d{2}$/);
    expect(describeBrief(null, 'America/Edmonton')).toBe("The business brief hasn't been built yet");
  });

  it('the owner profile round-trips through settings', async () => {
    await saveOwnerProfile({ ...EMPTY_PROFILE, goals: 'Hit $50k/month', grossMarginPct: 70 });
    expect(await getOwnerProfile()).toMatchObject({ goals: 'Hit $50k/month', grossMarginPct: 70 });
  });
});
