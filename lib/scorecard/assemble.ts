/**
 * The scorecard — ONE assembly shared by the /scorecard page and the Monday /
 * monthly email (lib/email/digests renders this model; it never computes a
 * number of its own). PURE: a ScorecardResult (+ the stored narrative) in,
 * a display model out. Every stat is a formatted value plus the engine Delta
 * it came from, so a tile on screen and a card in the email agree to the
 * digit, and each stat's `key` is also its trend-popover metric.
 *
 * Section order is Jake's reading order: Money → Pipeline → Ads.
 */

import type { ScorecardResult } from '../metrics/service';
import { FUNNEL_STAGES, formatCents, formatPct, formatDelta, computeDelta, type Delta, type CampaignRow, type ShowRate } from '../metrics';
import { periodFamily, periodTitle, formatRangeLabel } from '../dates';

export type ScorecardKind = 'weekly' | 'monthly' | 'custom';
export type StatTone = 'good' | 'bad' | 'neutral';

export interface ScorecardStat {
  /** Stable id — also the KpiTrendPopover metric key. */
  key: string;
  label: string;
  /** Formatted for display ("$1,234", "41%", "2.5×", "12"). */
  value: string;
  delta: Delta;
  deltaKind: 'count' | 'cents' | 'pct' | 'ratio';
  /** One-line context: the formatted delta, or why the value is unavailable. */
  sub: string;
  tone: StatTone;
  /** Present when the number must NOT be shown (inputs missing). */
  empty?: { title: string; description: string };
}

export interface CampaignPick {
  campaignName: string;
  platform: string;
  spendCents: number;
  enrolled: number;
  costPerEnrollmentCents: number;
}

export interface ScorecardView {
  kind: ScorecardKind;
  /** "Week of Sep 6–12" / "September 2026" / resolved label. */
  title: string;
  /** "vs Aug 30 – Sep 5" or null. */
  subtitle: string | null;
  period: { start: string; end: string; label: string };
  comparison: { start: string; end: string; label: string } | null;
  sections: { money: ScorecardStat[]; pipeline: ScorecardStat[]; ads: ScorecardStat[] };
  campaigns: { top: CampaignPick | null; worst: CampaignPick | null; note: string };
  /** Funnel table rows: [stage, count, of applied, from previous, cost per]. */
  funnelRows: string[][];
  showRows: string[][];
  sourceRows: string[][];
  cacLine: string;
  /** Data-health / provenance notes (awaiting Stripe, unclassified payments…). */
  notes: Array<{ text: string; tone: 'info' | 'warn' }>;
  narrative: string | null;
  narrativeTitle: string;
  empty: boolean;
  /** Email subject line. */
  subject: string;
}

function deltaSub(d: Delta, kind: ScorecardStat['deltaKind']): { sub: string; tone: StatTone } {
  if (d.abs === null) return { sub: 'no comparison', tone: 'neutral' };
  if (d.abs === 0) return { sub: 'no change', tone: 'neutral' };
  return { sub: formatDelta(d, kind), tone: d.good === null ? 'neutral' : d.good ? 'good' : 'bad' };
}

function stat(key: string, label: string, value: string, delta: Delta, deltaKind: ScorecardStat['deltaKind'], override?: { sub: string; tone?: StatTone; empty?: ScorecardStat['empty'] }): ScorecardStat {
  const ds = deltaSub(delta, deltaKind);
  return { key, label, value, delta, deltaKind, sub: override?.sub ?? ds.sub, tone: override?.tone ?? ds.tone, empty: override?.empty };
}

function rateOf(rows: ShowRate[] | null, type: string): number | null {
  return rows?.find((r) => r.type === type)?.rate ?? null;
}

export function scorecardKindOf(result: ScorecardResult): ScorecardKind {
  const f = periodFamily(result.range);
  return f === 'week' ? 'weekly' : f === 'month' ? 'monthly' : 'custom';
}

export function assembleScorecard(result: ScorecardResult, narrative: string | null): ScorecardView {
  const { scorecard, comparison, ads } = result;
  const r = result.range;
  const k = scorecard.kpis;
  const m = scorecard.marketing;
  const rev = scorecard.revenue;
  const awaiting = rev.awaitingStripe;
  const kind = scorecardKindOf(result);
  const cmp = comparison.range;

  // ---- Money -------------------------------------------------------------
  const stripeEmpty = { title: 'Awaiting Stripe', description: 'Connect Stripe in Setup — nothing here is estimated.' };
  const money: ScorecardStat[] = [
    awaiting
      ? stat('initial_cash', 'Initial cash collected', '—', k.initialCents, 'cents', { sub: 'Awaiting Stripe', empty: stripeEmpty })
      : stat('initial_cash', 'Initial cash collected', formatCents(k.initialCents.current), k.initialCents, 'cents'),
    stat('enrollments', 'Enrollments', String(k.enrollments.current ?? 0), k.enrollments, 'count'),
    stat('paid_cac', 'Paid CAC', k.paidCacCents.current === null ? '—' : formatCents(k.paidCacCents.current), k.paidCacCents, 'cents',
      k.paidCacCents.current === null ? { sub: m.noSpendData ? 'no spend entered' : 'no paid-attributed enrollments' } : undefined),
    stat('blended_cac', 'Blended CAC', k.blendedCacCents.current === null ? '—' : formatCents(k.blendedCacCents.current), k.blendedCacCents, 'cents',
      k.blendedCacCents.current === null ? { sub: m.noSpendData ? 'no spend entered' : 'no enrollments' } : undefined),
    awaiting
      ? stat('roas', 'ROAS', '—', k.roas, 'ratio', { sub: 'Awaiting Stripe', empty: stripeEmpty })
      : stat('roas', 'ROAS', k.roas.current === null ? '—' : `${k.roas.current.toFixed(2)}×`, k.roas, 'ratio', k.roas.current === null ? { sub: 'no spend in period' } : undefined),
    stat('ltv_cac', 'LTV:CAC', k.ltvToCac.current === null ? '—' : `${k.ltvToCac.current.toFixed(1)}×`, k.ltvToCac, 'ratio',
      k.ltvToCac.current === null
        ? {
            sub: m.contractValueMissing.length ? `${m.contractValueMissing.length} new client${m.contractValueMissing.length === 1 ? '' : 's'} missing contract value` : m.enrollments === 0 ? 'no new clients' : 'no spend in period',
            empty: m.contractValueMissing.length
              ? { title: 'Contract value missing', description: `${m.contractValueMissing.map((p) => p.name).join(', ')} — set the opportunity value in GHL.` }
              : undefined,
          }
        : undefined),
  ];

  // ---- Pipeline ----------------------------------------------------------
  const consultRate = rateOf(scorecard.showRates, 'Consult');
  const roadmapRate = rateOf(scorecard.showRates, 'Roadmap');
  const consultRateDelta = computeDelta(consultRate, rateOf(scorecard.previousShowRates, 'Consult'));
  const roadmapRateDelta = computeDelta(roadmapRate, rateOf(scorecard.previousShowRates, 'Roadmap'));
  const pipeline: ScorecardStat[] = [
    stat('applied', 'Applied', String(k.applied.current ?? 0), k.applied, 'count'),
    stat('consults_booked', 'Consults booked', String(k.consultsBooked.current ?? 0), k.consultsBooked, 'count'),
    stat('consult_show_rate', 'Consult show rate', formatPct(consultRate), consultRateDelta, 'pct', consultRate === null ? { sub: 'no decided consults' } : undefined),
    stat('roadmaps_booked', 'Roadmaps booked', String(k.roadmapsBooked.current ?? 0), k.roadmapsBooked, 'count'),
    stat('roadmap_show_rate', 'Roadmap show rate', formatPct(roadmapRate), roadmapRateDelta, 'pct', roadmapRate === null ? { sub: 'no decided roadmaps' } : undefined),
  ];

  // ---- Ads ---------------------------------------------------------------
  const a = ads.kpis;
  const pa = ads.previousKpis;
  const costStat = (key: string, label: string, cur: number | null, prev: number | null | undefined, missing: string) =>
    stat(key, label, cur === null ? '—' : formatCents(cur), computeDelta(cur, prev ?? null, true), 'cents', cur === null ? { sub: m.noSpendData ? 'no spend entered' : missing } : undefined);
  const adsStats: ScorecardStat[] = [
    stat('spend', 'Spend', formatCents(a.spendCents), computeDelta(a.spendCents, pa?.spendCents ?? null, true), 'cents', m.noSpendData ? { sub: 'no spend entered' } : undefined),
    costStat('cpl', 'Cost per lead', a.costPerLeadCents, pa?.costPerLeadCents, 'no applicants'),
    costStat('cost_consult', 'Cost per consult', a.costPerConsultCents, pa?.costPerConsultCents, 'no consults booked'),
    costStat('cost_roadmap', 'Cost per roadmap', a.costPerRoadmapCents, pa?.costPerRoadmapCents, 'no roadmaps booked'),
    costStat('cost_client', 'Cost per client', a.blendedCacCents, pa?.blendedCacCents, 'no enrollments'),
  ];

  const priced = ads.campaigns.filter((c): c is CampaignRow & { costPer: { enrolled: number } } => c.from === 'api' && c.costPer.enrolled !== null);
  const pick = (c: CampaignRow): CampaignPick => ({ campaignName: c.campaignName, platform: c.platform, spendCents: c.spendCents, enrolled: c.tracked.enrolled, costPerEnrollmentCents: c.costPer.enrolled ?? 0 });
  const sorted = [...priced].sort((x, y) => (x.costPer.enrolled ?? 0) - (y.costPer.enrolled ?? 0));
  const top = sorted[0] ? pick(sorted[0]) : null;
  const worst = sorted.length > 1 ? pick(sorted[sorted.length - 1]) : null;
  const campaignNote =
    ads.campaigns.length === 0
      ? 'No campaign spend in the period.'
      : priced.length === 0
        ? ads.campaigns.some((c) => c.from === 'api')
          ? 'No campaign produced an enrollment in the period, so none can be ranked by cost per client.'
          : 'Only manual weekly spend — connect Meta Ads to rank campaigns.'
        : priced.length === 1
          ? 'Only one campaign produced enrollments — nothing to rank against.'
          : '';

  // ---- Tables (funnel / show rates / sources) ----------------------------
  const funnelRows = scorecard.funnel.stages.map((s) => [
    FUNNEL_STAGES.find((f) => f.key === s.key)?.label ?? s.key,
    String(s.count),
    formatPct(s.shareOfApplied),
    s.conversionFromPrevious === null ? '—' : formatPct(s.conversionFromPrevious),
    s.costPerCents === null ? '—' : formatCents(s.costPerCents),
  ]);
  if (scorecard.funnel.previousLeads.count > 0) {
    funnelRows.push(['Previous leads (parked, not in conversion)', String(scorecard.funnel.previousLeads.count), '—', '—', '—']);
  }
  const showRows = scorecard.showRates.map((s) => [s.type, String(s.showed), String(s.noShow), String(s.cancelled), formatPct(s.rate)]);
  const sourceRows = scorecard.sources.slice(0, 8).map((s) => [s.source, String(s.counts.applied), String(s.counts.consult_booked), String(s.counts.enrolled), formatPct(s.appliedToEnrolled)]);

  const cacLine = m.noSpendData
    ? 'No ad spend entered for this period — add weekly spend on the Ads tab to get CAC.'
    : m.enrollments === 0
      ? `${formatCents(m.spendCents)} spend, no enrollments this period.`
      : [
          `Paid CAC: ${formatCents(m.spendCents)} spend ÷ ${m.paidEnrollments} paid-attributed enrollment${m.paidEnrollments === 1 ? '' : 's'} = ${m.paidCacCents === null ? '—' : formatCents(m.paidCacCents)}.`,
          `Blended CAC: ${formatCents(m.spendCents)} ÷ ${m.enrollments} enrollments (${m.organicEnrollments} organic) = ${formatCents(m.blendedCacCents)}.`,
          m.ltvToCac !== null
            ? `LTV:CAC: ${formatCents(m.contractValueCents)} contract value ÷ ${formatCents(m.spendCents)} spend = ${m.ltvToCac.toFixed(1)}×.`
            : m.contractValueMissing.length
              ? `LTV:CAC withheld — no contract value in GHL for: ${m.contractValueMissing.map((p) => p.name).join(', ')}.`
              : '',
          m.unattributedEnrollments ? `${m.unattributedEnrollments} enrollment(s) have no paid/organic class and are excluded from Paid CAC.` : '',
        ]
          .filter(Boolean)
          .join(' ');

  const notes: ScorecardView['notes'] = [];
  if (awaiting) notes.push({ text: 'Revenue and ROAS will appear once Stripe is connected. Nothing here is estimated.', tone: 'info' });
  else notes.push({ text: `Initial cash = new-client payments only, net of refunds (${formatCents(rev.recurringCents)} recurring collected separately). ROAS = paid-attributed initial cash ÷ spend.`, tone: 'info' });
  if (rev.unclassifiedCount > 0) notes.push({ text: `${rev.unclassifiedCount} succeeded payment(s) have no payment class — run npm run reclassify:payments.`, tone: 'warn' });
  if (m.unattributedInitialCount > 0) notes.push({ text: `${formatCents(m.unattributedInitialCents)} of initial cash is unmatched or unclassified and excluded from ROAS.`, tone: 'warn' });

  const title = periodTitle(r);
  return {
    kind,
    title,
    subtitle: cmp ? `vs ${cmp.resolvedLabel}` : null,
    period: { start: r.start, end: r.end, label: r.resolvedLabel },
    comparison: cmp ? { start: cmp.start, end: cmp.end, label: cmp.resolvedLabel } : null,
    sections: { money, pipeline, ads: adsStats },
    campaigns: { top, worst, note: campaignNote },
    funnelRows,
    showRows,
    sourceRows,
    cacLine,
    notes,
    narrative,
    narrativeTitle: kind === 'monthly' ? 'This month in one paragraph' : 'This week in one paragraph',
    empty: scorecard.empty,
    subject: `FitFlow ${kind === 'custom' ? '' : `${kind} `}scorecard — ${formatRangeLabel(r.start, r.end)}: ${k.enrollments.current ?? 0} enrolled, ${k.consultsBooked.current ?? 0} consults booked`,
  };
}
