/**
 * Insight-card input assembly — PURE. Turns a ScorecardResult into the
 * compact JSON snapshot Claude reasons over, plus the deep-link map every
 * finding must point into, the hash used for caching in ai_reports, and the
 * Zod validator for Claude's answer.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScorecardResult } from './service';
import { FUNNEL_STAGES, type FunnelStageKey } from './index';

export interface InsightInput {
  period: { label: string; start: string; end: string; preset: string };
  comparison: { label: string; start: string; end: string } | null;
  baseline: { start: string; end: string; note: string };
  funnel: Array<{
    stage: FunnelStageKey;
    label: string;
    count: number;
    previousCount: number | null;
    changePct: number | null;
    conversionFromPrevious: number | null;
    previousConversion: number | null;
    toneVsBaseline: string;
  }>;
  showRates: Array<{ type: string; showed: number; noShow: number; rate: number | null }>;
  money: {
    spendCents: number;
    /** Blended CAC (spend ÷ all enrollments). */
    cacCents: number | null;
    previousCacCents: number | null;
    paidCacCents: number | null;
    previousPaidCacCents: number | null;
    blendedCacCents: number | null;
    paidEnrollments: number;
    organicEnrollments: number;
    unattributedEnrollments: number;
    ltvToCac: number | null;
    contractValueCents: number;
    contractValueMissingCount: number;
    costPerRoadmapCents: number | null;
    definitions: string;
    revenue:
      | { awaitingStripe: true }
      | { awaitingStripe: false; initialCents: number; recurringCents: number; collectedCents: number; roas: number | null; paidInitialCents: number; roasNote: string };
  };
  sources: Array<{
    source: string;
    applied: number;
    consultsBooked: number;
    consultsShowed: number;
    enrolled: number;
    consultShowRate: number | null;
    appliedToEnrolled: number | null;
  }>;
  warnings: Array<{ from: FunnelStageKey; to: FunnelStageKey; current: number | null; previous: number | null }>;
  deepLinks: Record<string, string>;
}

const round = (n: number | null, d = 3) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function buildInsightInput(result: ScorecardResult): InsightInput {
  const { scorecard, range, comparison, baseline } = result;
  const q = `range=${range.preset}${range.preset === 'custom' ? `&start=${range.start}&end=${range.end}` : ''}&compare=${comparison.mode}`;

  const deepLinks: Record<string, string> = { funnel: `/funnel?${q}`, ads: `/ads?${q}`, command_center: `/?${q}` };
  for (const s of FUNNEL_STAGES) deepLinks[`stage:${s.key}`] = `/funnel?${q}&stage=${s.key}`;
  for (const s of scorecard.sources) deepLinks[`source:${s.source}`] = `/clients?source=${encodeURIComponent(s.source)}`;

  const prevStage = (key: FunnelStageKey) => scorecard.previousFunnel?.stages.find((s) => s.key === key) ?? null;

  const funnel = scorecard.funnel.stages.map((s) => {
    const prev = prevStage(s.key);
    const conv = scorecard.conversions.find((c) => c.to === s.key);
    return {
      stage: s.key,
      label: s.label,
      count: s.count,
      previousCount: prev ? prev.count : null,
      changePct: prev && prev.count > 0 ? round((s.count - prev.count) / prev.count) : null,
      conversionFromPrevious: round(s.conversionFromPrevious),
      previousConversion: round(conv?.previous ?? null),
      toneVsBaseline: conv?.tone ?? 'neutral',
    };
  });

  const rev = scorecard.revenue;
  return {
    period: { label: range.resolvedLabel, start: range.start, end: range.end, preset: range.preset },
    comparison: comparison.range ? { label: comparison.range.resolvedLabel, start: comparison.range.start, end: comparison.range.end } : null,
    baseline: { ...baseline, note: 'trailing 8 complete Sun–Sat weeks; toneVsBaseline compares each conversion against it' },
    funnel,
    showRates: scorecard.showRates.map((s) => ({ type: s.type, showed: s.showed, noShow: s.noShow, rate: round(s.rate) })),
    money: {
      spendCents: scorecard.cac.spendCents,
      cacCents: scorecard.cac.cacCents,
      previousCacCents: scorecard.kpis.cacCents.previous,
      paidCacCents: scorecard.marketing.paidCacCents,
      previousPaidCacCents: scorecard.kpis.paidCacCents.previous,
      blendedCacCents: scorecard.marketing.blendedCacCents,
      paidEnrollments: scorecard.marketing.paidEnrollments,
      organicEnrollments: scorecard.marketing.organicEnrollments,
      unattributedEnrollments: scorecard.marketing.unattributedEnrollments,
      ltvToCac: round(scorecard.marketing.ltvToCac, 2),
      contractValueCents: scorecard.marketing.contractValueCents,
      contractValueMissingCount: scorecard.marketing.contractValueMissing.length,
      costPerRoadmapCents: scorecard.marketing.costPerRoadmapCents,
      definitions:
        'Paid CAC = spend ÷ paid-attributed enrollments; Blended CAC = spend ÷ all enrollments; ROAS = paid-attributed initial (new-client) cash ÷ spend; LTV:CAC = total contract value of new clients ÷ spend (null while any new client lacks a contract value). Money is integer cents.',
      revenue: rev.awaitingStripe
        ? { awaitingStripe: true }
        : {
            awaitingStripe: false,
            initialCents: rev.initialCents,
            recurringCents: rev.recurringCents,
            collectedCents: rev.collectedCents,
            roas: round(scorecard.marketing.roas),
            paidInitialCents: scorecard.marketing.paidInitialCents,
            roasNote: 'ROAS = paid-attributed initial (new-client) cash ÷ spend; recurring cash and organic clients are excluded',
          },
    },
    sources: scorecard.sources.slice(0, 10).map((s) => ({
      source: s.source,
      applied: s.counts.applied,
      consultsBooked: s.counts.consult_booked,
      consultsShowed: s.counts.consult_showed,
      enrolled: s.counts.enrolled,
      consultShowRate: round(s.consultShowRate),
      appliedToEnrolled: round(s.appliedToEnrolled),
    })),
    warnings: scorecard.conversions
      .filter((c) => c.tone === 'warn')
      .slice(0, 5)
      .map((c) => ({ from: c.from, to: c.to, current: round(c.current), previous: round(c.previous) })),
    deepLinks,
  };
}

/** Stable sha256 of the input so identical snapshots reuse a cached report. */
export function hashInsightInput(input: InsightInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export const InsightFindingSchema = z.object({
  title: z.string().min(1).max(90),
  detail: z.string().min(1).max(240),
  metric: z.string().min(1).max(60),
  direction: z.enum(['up', 'down', 'flat']),
  severity: z.enum(['info', 'warning', 'good']),
  link: z.string().min(1),
});
export type InsightFinding = z.infer<typeof InsightFindingSchema>;

export const InsightsAnswerSchema = z.object({ findings: z.array(InsightFindingSchema).max(3) });

/** Validate Claude's answer AND pin every link to one of the offered deep links. */
export function validateInsights(answer: unknown, deepLinks: Record<string, string>): { ok: true; findings: InsightFinding[] } | { ok: false; error: string } {
  const parsed = InsightsAnswerSchema.safeParse(answer);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  const allowed = new Set(Object.values(deepLinks));
  const bad = parsed.data.findings.find((f) => !allowed.has(f.link));
  if (bad) return { ok: false, error: `link not in deepLinks: ${bad.link}` };
  return { ok: true, findings: parsed.data.findings };
}
