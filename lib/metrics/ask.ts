/**
 * Ask-the-dashboard context — PURE (Phase G item 8).
 *
 * `buildAskContext` turns a ScorecardResult into the JSON Claude answers
 * from: the same insight snapshot the nightly cards use, plus the prior
 * period, the trailing 8 weeks week by week, the campaign table, both funnel
 * modes and the marketing economics. `verifyAnswerNumbers` then checks that
 * every number in the model's answer and citations exists in that context
 * (allowing the cents→dollars, ratio→percent and rounding the prompt asks
 * for). An answer that cites a number the context does not contain is never
 * saved.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScorecardResult } from './service';
import { buildInsightInput, type InsightInput } from './insights';
import type { CampaignRow, Funnel, MarketingMetrics, TrendPoint } from './index';
import { dataCaveats } from './maturity';

export interface AskContext {
  note: string;
  snapshot: InsightInput;
  marketing: { current: MarketingMetrics; previous: MarketingMetrics | null };
  /** The period funnel (and comparison) in both modes. */
  funnel: {
    period: FunnelSlice;
    cohort: FunnelSlice;
    previousPeriod: FunnelSlice | null;
    previousCohort: FunnelSlice | null;
  };
  /** Sun–Sat weeks: the selected range, then the 8 trailing weeks before it. */
  weekly: { inRange: WeekSlice[]; trailing8: WeekSlice[] };
  campaigns: CampaignSlice[];
  previousCampaigns: CampaignSlice[] | null;
  dataHealth: string[];
  /** Maturing-data caveats — same wording as the badge; empty after sunset. */
  dataCaveats: string[];
}

interface FunnelSlice {
  mode: Funnel['mode'];
  range: Funnel['range'];
  spendCents: number;
  stages: Array<{ stage: string; count: number; shareOfApplied: number | null; conversionFromPrevious: number | null; dropOff: number; costPerCents: number | null }>;
  previousLeads: number;
}
interface WeekSlice {
  week: string;
  start: string;
  end: string;
  applied: number;
  consultsBooked: number;
  enrolled: number;
  spendCents: number;
  blendedCacCents: number | null;
  initialCents: number;
  recurringCents: number;
}
interface CampaignSlice {
  campaign: string;
  platform: string;
  from: 'api' | 'manual';
  spendCents: number;
  impressions: number;
  reach: number;
  linkClicks: number;
  cpmCents: number | null;
  cpcCents: number | null;
  platformLeads: number;
  tracked: CampaignRow['tracked'];
  costPer: CampaignRow['costPer'];
  initialCents: number;
  roas: number | null;
}

const round = (n: number | null, d = 3) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

function funnelSlice(f: Funnel): FunnelSlice {
  return {
    mode: f.mode,
    range: f.range,
    spendCents: f.spendCents,
    stages: f.stages.map((s) => ({
      stage: s.key,
      count: s.count,
      shareOfApplied: round(s.shareOfApplied),
      conversionFromPrevious: round(s.conversionFromPrevious),
      dropOff: s.dropOff,
      costPerCents: s.costPerCents,
    })),
    previousLeads: f.previousLeads.count,
  };
}

function weekSlice(p: TrendPoint): WeekSlice {
  return {
    week: p.label,
    start: p.start,
    end: p.end,
    applied: p.applied,
    consultsBooked: p.consultsBooked,
    enrolled: p.enrolled,
    spendCents: p.spendCents,
    blendedCacCents: p.cacCents,
    initialCents: p.initialCents,
    recurringCents: p.recurringCents,
  };
}

function campaignSlice(c: CampaignRow): CampaignSlice {
  return {
    campaign: c.campaignName,
    platform: c.platform,
    from: c.from,
    spendCents: c.spendCents,
    impressions: c.impressions,
    reach: c.reach,
    linkClicks: c.linkClicks,
    cpmCents: c.cpmCents,
    cpcCents: c.cpcCents,
    platformLeads: c.platformLeads,
    tracked: c.tracked,
    costPer: c.costPer,
    initialCents: c.initialCents,
    roas: round(c.roas),
  };
}

function roundMarketing(m: MarketingMetrics): MarketingMetrics {
  return { ...m, roas: round(m.roas), ltvToCac: round(m.ltvToCac, 2) };
}

export function buildAskContext(result: ScorecardResult): AskContext {
  const { scorecard } = result;
  const m = scorecard.marketing;
  const dataHealth: string[] = [];
  if (scorecard.revenue.awaitingStripe) dataHealth.push('Stripe is not connected: no revenue, initial cash or ROAS exists.');
  if (m.noSpendData) dataHealth.push('No ad spend recorded for the period: every cost metric and ROAS is unavailable.');
  if (m.contractValueMissing.length) dataHealth.push(`LTV:CAC withheld: ${m.contractValueMissing.length} new client(s) have no contract value in GHL (${m.contractValueMissing.map((p) => p.name).join(', ')}).`);
  if (m.unattributedEnrollments) dataHealth.push(`${m.unattributedEnrollments} enrollment(s) have no paid/organic class and are excluded from Paid CAC.`);
  if (m.unattributedInitialCount) dataHealth.push(`${m.unattributedInitialCount} initial payment(s) are unmatched/unclassified and excluded from ROAS.`);
  if (scorecard.revenue.unclassifiedCount) dataHealth.push(`${scorecard.revenue.unclassifiedCount} succeeded payment(s) have no payment class.`);

  return {
    note: 'Money is integer cents. Ratios are 0–1. "period" funnel = events inside the dates; "cohort" funnel = people who applied inside the dates and every stage they reached since. Paid CAC = spend ÷ paid-attributed enrollments; Blended CAC = spend ÷ all enrollments; ROAS = paid-attributed initial cash ÷ spend; LTV:CAC = total contract value of new clients ÷ spend.',
    snapshot: buildInsightInput(result),
    marketing: {
      current: roundMarketing(m),
      previous: result.comparison.range ? roundMarketing(previousMarketing(result)) : null,
    },
    funnel: {
      period: funnelSlice(scorecard.funnel),
      cohort: funnelSlice(scorecard.cohort.funnel),
      previousPeriod: scorecard.previousFunnel ? funnelSlice(scorecard.previousFunnel) : null,
      previousCohort: scorecard.cohort.previousFunnel ? funnelSlice(scorecard.cohort.previousFunnel) : null,
    },
    weekly: { inRange: result.trendWeekly.current.map(weekSlice), trailing8: result.trailingWeeks.map(weekSlice) },
    campaigns: result.ads.campaigns.map(campaignSlice),
    previousCampaigns: result.ads.previousCampaigns?.map(campaignSlice) ?? null,
    dataHealth,
    dataCaveats: dataCaveats(result.maturity),
  };
}

/**
 * The comparison period's marketing metrics are not carried on the scorecard
 * as a block, but every KPI delta holds its `previous` value; rebuild the few
 * that matter for the model from those.
 */
function previousMarketing(result: ScorecardResult): MarketingMetrics {
  const k = result.scorecard.kpis;
  const prev = result.ads.previousKpis;
  const m = result.scorecard.marketing;
  return {
    ...m,
    spendCents: prev?.spendCents ?? 0,
    enrollments: k.enrollments.previous ?? 0,
    paidEnrollments: 0,
    organicEnrollments: 0,
    unattributedEnrollments: 0,
    initialCents: k.initialCents.previous ?? 0,
    paidInitialCents: 0,
    organicInitialCents: 0,
    unattributedInitialCents: 0,
    unattributedInitialCount: 0,
    roas: k.roas.previous,
    paidCacCents: k.paidCacCents.previous,
    blendedCacCents: k.blendedCacCents.previous,
    costPerRoadmapCents: k.costPerRoadmapCents.previous,
    contractValueCents: 0,
    contractValueMissing: [],
    ltvToCac: k.ltvToCac.previous,
  };
}

export function hashAskContext(context: AskContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

// ---------------------------------------------------------------------------
// Number grounding
// ---------------------------------------------------------------------------

/** Every finite number anywhere in the context. */
export function collectNumbers(value: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectNumbers(v, out);
  }
  return out;
}

/** Numbers as they appear in prose: $1,234.56 · 41% · 2.5× · 12 · -3 */
const NUMBER_TOKEN = /(?<![\w.])(\$?)(-?\d[\d,]*(?:\.\d+)?)(%|×|x|k)?(?![\w])/gi;

function close(a: number, t: number): boolean {
  return Math.abs(a - t) <= Math.max(0.5, Math.abs(a) * 0.01);
}
function closeRatio(a: number, t: number): boolean {
  return Math.abs(a - t) <= 0.0051;
}

/** Could `candidate` (as written) be a rendering of some context number? */
export function isGroundedNumber(candidate: number, suffix: string, allowed: Set<number>): boolean {
  if (Number.isInteger(candidate) && candidate >= 0 && candidate <= 31) return true; // dates, day/week counts
  if (Number.isInteger(candidate) && candidate >= 2020 && candidate <= 2035) return true; // years
  for (const a of allowed) {
    if (suffix === '%') {
      if (closeRatio(a, candidate / 100)) return true; // ratio rendered as percent
      if (close(a, candidate)) return true; // already a percentage in context
      continue;
    }
    if (close(a, candidate)) return true; // count / ratio / multiple verbatim
    if (close(a, candidate * 100)) return true; // dollars ← cents
    if (closeRatio(a, candidate)) return true; // rounded ratio / multiple
  }
  return false;
}

export interface GroundingResult {
  ok: boolean;
  /** Number tokens (as written) that no context value could have produced. */
  unknown: string[];
}

/** Every number in the prose AND every citation value must exist in the context. */
export function verifyAnswerNumbers(answer: string, citations: Array<{ value: number }>, context: unknown): GroundingResult {
  const allowed = collectNumbers(context);
  const unknown: string[] = [];
  // ISO dates and ranges are not metrics.
  const prose = answer.replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\b(\d+)[-–](\d+)\b/g, ' ');
  for (const m of prose.matchAll(NUMBER_TOKEN)) {
    const raw = m[2].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const suffix = (m[3] ?? '').toLowerCase();
    const scaled = suffix === 'k' ? value * 1000 : value;
    if (!isGroundedNumber(scaled, suffix === 'k' ? '' : suffix, allowed)) unknown.push(m[0].trim());
  }
  for (const c of citations) {
    if (!Number.isFinite(c.value)) continue;
    if (![...allowed].some((a) => close(a, c.value) || closeRatio(a, c.value))) unknown.push(`citation ${c.value}`);
  }
  return { ok: unknown.length === 0, unknown: Array.from(new Set(unknown)) };
}

export const AskCitationSchema = z.object({ label: z.string().min(1).max(120), value: z.number(), path: z.string().min(1).max(200) });
export const AskAnswerSchema = z.object({ answer: z.string().min(1).max(2000), citations: z.array(AskCitationSchema).max(30) });
export type AskAnswer = z.infer<typeof AskAnswerSchema>;
