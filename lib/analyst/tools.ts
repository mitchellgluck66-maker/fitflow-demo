/**
 * Analyst tools (plan item 4): one strict, READ-ONLY tool per capability, each
 * a thin wrapper over the function the page calls (lib/metrics/service,
 * lib/queries, lib/sync/sourceFreshness), so a tool result and the page can
 * never disagree. Nothing here writes anything.
 *
 * Every result is `{ ref, range, currency, fx, freshness, data }`. A number
 * inside `data` is cited by the ref of the call plus its JSON path, e.g.
 * `r3:data.kpis.enrollments.current` — stable, and re-derivable from the
 * stored tool-result row (lib/analyst/ledger.ts). Lists are paginated (25 a
 * page) and every result is size-capped. Names only: no email or phone ever
 * leaves a tool (`scrubContact`; tests/analyst-tools.test.ts proves it).
 */

import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db, contacts, stages, appliedLedger } from '@/db';
import { readAppliedSummary, summarizeWeek, type LedgerRowInput } from '../reconcile/appliedLedger';
import { readRatioSummary } from '../reconcile/appliedRatio';
import { CLASS_LABELS, type ApplicationClass } from '../reconcile/applied';
import { CANDIDATE_LABEL, CURRENT_LABEL } from '../reconcile/definitions';
import type { BetaTool } from './api';
import { z } from 'zod';
import { describeZodIssues, zodFromJsonSchema } from '../anthropic/jsonSchemaToZod';
import { getScorecard, getMetricTrend, getTodoBuckets } from '../metrics/service';
import { computeRevenueSummary, computeSourceBreakdown, formatCents, formatPct, FUNNEL_STAGES, TODO_LABELS, REBOOK_LABELS, type Currency, type FunnelStageKey } from '../metrics';
import { loadMetricsInput } from '../metrics/load';
import { glossaryEntry, GLOSSARY_KEYS } from '../metrics/glossary';
import { isMaturingMetric, isMaturingStage } from '../metrics/maturity';
import { TREND_METRICS, TREND_WINDOWS, type TrendWindow } from '../metrics/trendMetrics';
import { listClients, getClientProfile } from '../queries/clients';
import { getTimezone } from '../settings';
import { todayInTimezone, PRESETS, rangeFromParams } from '../dates';
import { freshnessSummary, readSyncStatus } from '../sync/sourceFreshness';
import { activeNotes, getOwnerProfile, profileGaps, withheldLine } from './notes';
import { DECISIONS_LOG } from './brief';

export const PAGE_SIZE = 25;
/** A result larger than this (JSON chars) is truncated with a note — the model pages instead. */
export const MAX_RESULT_CHARS = 60_000;

export interface Freshness {
  stale: boolean;
  line: string;
  sources: Array<{ key: string; configured: boolean; stale: boolean; ageHours: number | null; detail: string | null }>;
}

export interface ToolContext {
  /** "r7" — the ordinal of this call in the thread; every number in the result is cited as `r7:data.<path>`. */
  ref: string;
  /** Computed once per turn by the runner; the same block on every result. */
  freshness: Freshness;
  /** `calculate` reads operands from earlier results through this. `undefined` = unknown ref. */
  resolveRef: (ref: string) => number | null | undefined;
}

export interface ToolResult {
  ref: string;
  range: { start: string; end: string; label: string } | null;
  currency: Currency;
  fx: string;
  freshness: Freshness;
  data: unknown;
  /** Set instead of `data` when the call could not run — the model reads it and corrects its input. */
  error?: string;
  truncated?: boolean;
}

export interface AnalystTool {
  definition: BetaTool;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<Omit<ToolResult, 'ref' | 'freshness'>>;
  /** Derived from `definition.input_schema`; runAnalystTool applies it before `run` (derived on the fly when absent). */
  validate?: z.ZodTypeAny;
}

// ---------------------------------------------------------------------------
// Shared schema pieces (strict: every property required, nullable via type arrays)
// ---------------------------------------------------------------------------

const PRESET_VALUES = PRESETS.map((p) => p.value).filter((p) => p !== 'custom');

/**
 * No nullables, no optionals anywhere in the tool schemas (2026-09-30): the API allows at most 16 union-typed and
 * 24 optional parameters PER REQUEST across every strict tool + the output format (lib/anthropic/schemaBudget.ts
 * enforces it before a request is sent). Every field is required; "not used" is a sentinel: preset "custom" with
 * start/end, "" for an unused string, "any" for an unused filter.
 */
const RANGE_SCHEMA = {
  type: 'object',
  description: 'The period. preset = a named period (last_week, this_week, last_month, this_month, last_30_days, today, yesterday) with start and end "", OR preset "custom" with start and end as YYYY-MM-DD (inclusive, business-local). Weeks are Sunday–Saturday.',
  properties: {
    preset: { type: 'string', enum: [...PRESET_VALUES, 'custom'] },
    start: { type: 'string', description: 'YYYY-MM-DD when preset is "custom"; "" otherwise.' },
    end: { type: 'string', description: 'YYYY-MM-DD when preset is "custom"; "" otherwise.' },
  },
  required: ['preset', 'start', 'end'],
  additionalProperties: false,
} as const;

const MODE_SCHEMA = { type: 'string', enum: ['period', 'cohort'], description: '"period" = events inside the dates (the tiles). "cohort" = everyone who applied inside the dates and every stage they reached since (the funnel default).' } as const;
const PAGE_SCHEMA = { type: 'integer', description: 'Page number, from 1. 25 rows a page.' } as const;

type RangeInput = { preset: string; start: string; end: string };

function rangeParams(r: RangeInput | null | undefined): { range?: string; start?: string; end?: string } {
  if (!r) return { range: 'last_week' };
  if (r.preset && r.preset !== 'custom') return { range: r.preset };
  if (r.start && r.end) return { range: 'custom', start: r.start, end: r.end };
  return { range: 'last_week' };
}

async function resolveRange(r: RangeInput | null | undefined) {
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const range = rangeFromParams(rangeParams(r), today);
  return { timezone, today, range, label: `${range.presetLabel} · ${range.resolvedLabel}` };
}

const rangeOut = (r: { start: string; end: string; presetLabel?: string; resolvedLabel?: string; label?: string }) => ({ start: r.start, end: r.end, label: r.label ?? (r.presetLabel ? `${r.presetLabel} · ${r.resolvedLabel}` : `${r.start} – ${r.end}`) });

function page(input: Record<string, unknown>): number {
  const p = Number(input.page);
  return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
}

function paginate<T>(rows: T[], p: number): { page: number; pages: number; total: number; rows: T[] } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const at = Math.min(p, pages);
  return { page: at, pages, total: rows.length, rows: rows.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE) };
}

/** Names only: strip every email / phone field and any value that looks like one, recursively. */
export function scrubContact<T>(value: T): T {
  const PII_KEYS = /^(email|emails|phone|phones|customer_?email|contact_?email|phone_?number|mobile)$/i;
  const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
  // A phone: 10–15 digits with only phone punctuation — and not an ISO date / timestamp.
  const looksLikePhone = (s: string) => {
    const t = s.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(t) || /[T:]/.test(t)) return false;
    const digits = t.replace(/\D/g, '');
    return /^\+?[\d\s().-]{9,}$/.test(t) && digits.length >= 10 && digits.length <= 15;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (PII_KEYS.test(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    if (typeof v === 'string' && (looksLikeEmail(v) || looksLikePhone(v))) return '[withheld]';
    return v;
  };
  return walk(value) as T;
}

async function namesFor(contactIds: string[]): Promise<Array<{ contactId: string; name: string; stage: string | null; link: string }>> {
  if (contactIds.length === 0) return [];
  const rows = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, stage: stages.name })
    .from(contacts)
    .leftJoin(stages, eq(stages.id, contacts.stageId))
    .where(inArray(contacts.id, contactIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return contactIds.map((id) => {
    const r = byId.get(id);
    return { contactId: id, name: r ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || 'Unknown' : 'Unknown', stage: r?.stage ?? null, link: `/clients/${id}` };
  });
}

const money = (cents: number | null, ccy: Currency) => formatCents(cents, ccy);

function summarizeFunnel(f: { mode: string; stages: Array<{ key: FunnelStageKey; label: string; count: number; shareOfApplied: number | null; conversionFromPrevious: number | null; conversionFrom: FunnelStageKey | null; capped: boolean; dropOff: number; costPerCents: number | null; withheld?: string | null }>; previousLeads: { count: number } }, maturity: { active: boolean } | null) {
  return {
    mode: f.mode,
    stages: f.stages.map((s) => ({
      key: s.key,
      label: s.label,
      count: s.withheld ? null : s.count,
      withheld: s.withheld ?? null,
      shareOfApplied: s.shareOfApplied,
      conversionFromPrevious: s.conversionFromPrevious,
      conversionFrom: s.conversionFrom,
      capped: s.capped,
      dropOff: s.dropOff,
      costPerCents: s.costPerCents,
      maturing: isMaturingStage(s.key, maturity as never),
    })),
    previousLeads: f.previousLeads.count,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Read tools are `strict: false` (2026-09-30, the third 400: "The compiled grammar is too large" with 15 strict
 * tools beside the answer schema — a limit with no documented number). The ONLY strict schema in a request is the
 * answer (output_config.format). Every tool input is validated server-side against the same JSON Schema the model
 * saw (lib/anthropic/jsonSchemaToZod.ts); an invalid input is an error RESULT the model reads and corrects.
 */
const tool = (definition: Omit<BetaTool, 'strict'>, run: AnalystTool['run']): AnalystTool => ({ definition: { ...definition, strict: false }, run, validate: zodFromJsonSchema(definition.input_schema, definition.name) });

const getScorecardTool = tool(
  {
    name: 'get_scorecard',
    description: 'The Command Center / Scorecard for a period: every KPI with its comparison delta, marketing economics (Paid CAC, Blended CAC, ROAS, LTV:CAC), the revenue split, both funnel modes, show rates, sources, the maturity caveat and the Applied caveat. Start here for "how did we do".',
    input_schema: {
      type: 'object',
      properties: {
        range: RANGE_SCHEMA,
        compare: { type: 'string', enum: ['previous_period', 'last_year', 'off'], description: 'What the deltas compare against.' },
      },
      required: ['range', 'compare'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const r = input.range as RangeInput;
    const res = await getScorecard({ ...rangeParams(r), compare: String(input.compare ?? 'previous_period') });
    const sc = res.scorecard;
    const kpis = Object.fromEntries(
      Object.entries(sc.kpis).map(([k, d]) => [k, { current: d.current, previous: d.previous, abs: d.abs, pct: d.pct, maturing: isMaturingMetric(k === 'consultsBooked' ? 'consults_booked' : k === 'roadmapsBooked' ? 'roadmaps_booked' : k === 'costPerRoadmapCents' ? 'cost_roadmap' : k, res.maturity) }]),
    );
    const m = sc.marketing;
    return {
      range: rangeOut(res.range),
      currency: res.money.currency,
      fx: res.money.fx.text,
      data: {
        comparison: res.comparison.range ? { ...rangeOut(res.comparison.range), label: res.comparison.label } : null,
        kpis,
        marketing: {
          spendCents: m.spendCents,
          enrollments: m.enrollments,
          paidEnrollments: m.paidEnrollments,
          organicEnrollments: m.organicEnrollments,
          unattributedEnrollments: m.unattributedEnrollments,
          initialCents: m.initialCents,
          paidInitialCents: m.paidInitialCents,
          organicInitialCents: m.organicInitialCents,
          unattributedInitialCents: m.unattributedInitialCents,
          paidCacCents: m.paidCacCents,
          blendedCacCents: m.blendedCacCents,
          roas: m.roas,
          ltvToCac: m.ltvToCac,
          ltvWithheldFor: m.contractValueMissing.map((c) => c.name),
          contractValueCents: m.contractValueCents,
          costPerRoadmapCents: m.costPerRoadmapCents,
          awaitingStripe: m.awaitingStripe,
          noSpendData: m.noSpendData,
        },
        revenue: {
          awaitingStripe: sc.revenue.awaitingStripe,
          collectedCents: sc.revenue.collectedCents,
          initialCents: sc.revenue.initialCents,
          recurringCents: sc.revenue.recurringCents,
          unclassifiedCents: sc.revenue.unclassifiedCents,
          refundedCents: sc.revenue.refundedCents,
          failedCount: sc.revenue.failedCount,
          initialCount: sc.revenue.initialCount,
          recurringCount: sc.revenue.recurringCount,
        },
        funnelPeriod: summarizeFunnel(sc.funnel, res.maturity),
        funnelCohort: summarizeFunnel(sc.cohort.funnel, res.maturity),
        showRates: sc.showRates.map((s) => ({ type: s.type, rate: s.rate, showed: s.showed, noShow: s.noShow, cancelled: s.cancelled, past: s.past, coverage: s.coverage, withheld: s.withheld })),
        sources: sc.sources.slice(0, 12).map((s) => ({ source: s.source, applied: s.counts.applied, consultBooked: s.counts.consult_booked, enrolled: s.counts.enrolled, appliedToEnrolled: s.appliedToEnrolled })),
        maturity: { active: res.maturity.active, historyCompleteSince: res.maturity.historyCompleteSince, comparisonTouches: Boolean(res.maturity.comparisonTouches), note: res.maturity.active ? 'History-dependent metrics (consults booked, roadmaps booked, cost per lead / consult / roadmap, stage→stage conversions) are maturing for this range or its comparison: a change in them is not a real change.' : null },
        appliedCaveat: { text: sc.appliedCaveat.text, applied: sc.appliedCaveat.applied, withoutFormRecord: sc.appliedCaveat.withoutFormRecord.length, otherPipelines: sc.appliedCaveat.otherPipelines.length },
        dataHealth: { applicantsWithoutDate: res.inputHealth?.applicantsWithoutDate.length ?? 0, appliedFromMove: res.inputHealth?.appliedFromMove ?? 0, unsupportedMoneyRows: res.money.unsupportedRows },
      },
    };
  },
);

const getFunnelTool = tool(
  {
    name: 'get_funnel',
    description: 'The funnel for a period in one mode: each stage\'s count, share of applied, stage→stage conversion (spanning withheld "showed" stages), drop-off and cost per stage; previous leads; the Applied caveat with names. Use get_stage_people for the people behind a stage.',
    input_schema: { type: 'object', properties: { range: RANGE_SCHEMA, mode: MODE_SCHEMA }, required: ['range', 'mode'], additionalProperties: false },
  },
  async (input) => {
    const res = await getScorecard({ ...rangeParams(input.range as RangeInput), compare: 'previous_period' });
    const sc = res.scorecard;
    const cohort = input.mode === 'cohort';
    const f = cohort ? sc.cohort.funnel : sc.funnel;
    const conv = cohort ? sc.cohort.conversions : sc.conversions;
    return {
      range: rangeOut(res.range),
      currency: res.money.currency,
      fx: res.money.fx.text,
      data: {
        ...summarizeFunnel(f, res.maturity),
        spendCents: f.spendCents,
        conversions: conv.map((c) => ({ from: c.from, to: c.to, current: c.current, previous: c.previous, capped: c.capped, tone: c.tone })),
        baseline: rangeOut({ ...res.baseline, label: `trailing 8 weeks · ${res.baseline.start} – ${res.baseline.end}` }),
        appliedCaveat: { text: sc.appliedCaveat.text, withoutFormRecord: sc.appliedCaveat.withoutFormRecord.map((p) => ({ name: p.name, reason: p.reason, link: `/clients/${p.contactId}` })), otherPipelines: sc.appliedCaveat.otherPipelines.map((p) => ({ name: p.name, pipeline: p.pipeline, link: `/clients/${p.contactId}` })) },
        maturityActive: res.maturity.active,
      },
    };
  },
);

const getStagePeopleTool = tool(
  {
    name: 'get_stage_people',
    description: 'Who is behind a funnel stage for a period: names, current stage and FitFlow links (25 a page). "who applied" / "who enrolled" questions use this, not list_clients.',
    input_schema: {
      type: 'object',
      properties: { range: RANGE_SCHEMA, stage: { type: 'string', enum: [...FUNNEL_STAGES.map((s) => s.key), 'previous_leads'] }, mode: MODE_SCHEMA, page: PAGE_SCHEMA },
      required: ['range', 'stage', 'mode', 'page'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const res = await getScorecard({ ...rangeParams(input.range as RangeInput), compare: 'off' });
    const f = input.mode === 'cohort' ? res.scorecard.cohort.funnel : res.scorecard.funnel;
    const ids = input.stage === 'previous_leads' ? f.previousLeads.contactIds : (f.stages.find((s) => s.key === input.stage)?.contactIds ?? []);
    const p = paginate(await namesFor(ids), page(input));
    return { range: rangeOut(res.range), currency: res.money.currency, fx: res.money.fx.text, data: { stage: input.stage, mode: input.mode, ...p } };
  },
);

const getCampaignsTool = tool(
  {
    name: 'get_campaigns',
    description: 'The Ads campaign table for a period (and the comparison period): spend, impressions, link clicks, CPM, CPC, platform leads, FitFlow-tracked applied/consults/roadmaps/enrolled with cost per each, matched initial cash and ROAS per campaign. A campaign with no matched applicant is "not tracked yet".',
    input_schema: { type: 'object', properties: { range: RANGE_SCHEMA, compare: { type: 'string', enum: ['previous_period', 'last_year', 'off'] } }, required: ['range', 'compare'], additionalProperties: false },
  },
  async (input) => {
    const res = await getScorecard({ ...rangeParams(input.range as RangeInput), compare: String(input.compare ?? 'previous_period') });
    const row = (c: (typeof res.ads.campaigns)[number]) => ({
      campaign: c.campaignName,
      platform: c.platform,
      from: c.from,
      spendCents: c.spendCents,
      impressions: c.impressions,
      reach: c.reach,
      frequency: c.frequency,
      cpmCents: c.cpmCents,
      linkClicks: c.linkClicks,
      cpcCents: c.cpcCents,
      landingPageViews: c.landingPageViews,
      platformLeads: c.platformLeads,
      purchases: c.purchases,
      trackedApplied: c.tracked.applied,
      trackedConsults: c.tracked.consult_booked,
      trackedRoadmaps: c.tracked.roadmap_booked,
      trackedEnrolled: c.tracked.enrolled,
      costPerApplied: c.costPer.applied,
      costPerConsult: c.costPer.consult_booked,
      costPerRoadmap: c.costPer.roadmap_booked,
      costPerClient: c.costPer.enrolled,
      initialCents: c.initialCents,
      roas: c.roas,
      notTrackedYet: c.from === 'api' && c.tracked.applied === 0,
    });
    const k = res.ads.kpis;
    return {
      range: rangeOut(res.range),
      currency: res.money.currency,
      fx: res.money.fx.text,
      data: {
        kpis: { spendCents: k.spendCents, costPerLeadCents: k.costPerLeadCents, costPerConsultCents: k.costPerConsultCents, costPerRoadmapCents: k.costPerRoadmapCents, paidCacCents: k.paidCacCents, blendedCacCents: k.blendedCacCents, roas: k.roas, apiConnected: k.apiConnected, byPlatform: k.byPlatform },
        campaigns: res.ads.campaigns.map(row),
        comparison: res.comparison.range ? { ...rangeOut(res.comparison.range), campaigns: (res.ads.previousCampaigns ?? []).map(row) } : null,
        maturityActive: res.maturity.active,
      },
    };
  },
);

const getRevenueTool = tool(
  {
    name: 'get_revenue',
    description: 'The Revenue tab totals for a period: cash collected split initial / recurring / unclassified, MRR (active subscriptions, not period-bound), still-unpaid invoices (one per invoice), refunds, unmatched payments. Use get_payments for the rows.',
    input_schema: { type: 'object', properties: { range: RANGE_SCHEMA }, required: ['range'], additionalProperties: false },
  },
  async (input) => {
    const res = await getScorecard({ ...rangeParams(input.range as RangeInput), compare: 'off' });
    const r = res.revenue;
    return {
      range: rangeOut(res.range),
      currency: r.currency,
      fx: res.money.fx.text,
      data: {
        awaitingStripe: r.awaitingStripe,
        collectedCents: r.collectedCents,
        initialCents: r.initialCents,
        initialCount: r.initialCount,
        recurringCents: r.recurringCents,
        recurringCount: r.recurringCount,
        unclassifiedCents: r.unclassifiedCents,
        unclassifiedCount: r.unclassifiedCount,
        mrrCents: r.mrrCents,
        activeSubscriptions: r.activeSubscriptions,
        failedCount: r.failedCount,
        failedCents: r.failedCents,
        failedLaterPaid: r.failedLaterPaid,
        refundedCents: r.refundedCents,
        refundCount: r.refundCount,
        unmatchedCount: r.unmatchedCount,
        paymentsInPeriod: r.payments.length,
      },
    };
  },
);

const getPaymentsTool = tool(
  {
    name: 'get_payments',
    description: 'Payment rows for a period (25 a page): amount in the reporting currency and as charged, status, class (initial / recurring / excluded with the reason), the matched person\'s name and cohort week. Filter by class or status.',
    input_schema: {
      type: 'object',
      properties: {
        range: RANGE_SCHEMA,
        paymentClass: { type: 'string', enum: ['any', 'initial', 'recurring', 'excluded', 'unclassified'], description: '"any" = every row.' },
        status: { type: 'string', enum: ['any', 'succeeded', 'failed', 'refunded', 'pending'], description: '"any" = every status.' },
        page: PAGE_SCHEMA,
      },
      required: ['range', 'paymentClass', 'status', 'page'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const { timezone, range } = await resolveRange(input.range as RangeInput);
    const metricsInput = await loadMetricsInput({ start: range.start, end: range.end, timezone });
    const summary = computeRevenueSummary(metricsInput, range);
    let rows = summary.payments;
    if (input.paymentClass && input.paymentClass !== 'any') rows = rows.filter((p) => (input.paymentClass === 'unclassified' ? p.paymentClass === null : p.paymentClass === input.paymentClass));
    if (input.status && input.status !== 'any') rows = rows.filter((p) => p.status === input.status);
    const p = paginate(
      rows.map((x) => ({
        id: x.id,
        on: x.on,
        kind: x.kind,
        status: x.status,
        stillUnpaid: Boolean(x.stillUnpaid),
        amountCents: x.amountCents,
        refundedCents: x.refundedCents,
        originalAmountCents: x.originalAmountCents,
        originalCurrency: x.originalCurrency,
        fxRate: x.fxRate,
        paymentClass: x.paymentClass,
        excludedReason: x.excludedReason,
        contactName: x.contactName,
        outsidePipeline: Boolean(x.outsidePipeline),
        cohortWeek: x.cohortWeek,
        description: x.description,
        link: x.contactId ? `/clients/${x.contactId}` : null,
      })),
      page(input),
    );
    return { range: rangeOut(range), currency: summary.currency, fx: '', data: p };
  },
);

const getTrendTool = tool(
  {
    name: 'get_trend',
    description: 'One metric over a window (30d daily · 3m / 6m weekly · 12m monthly), with the equivalent span before it and the whole-window value — the same series as the KPI trend popover.',
    input_schema: {
      type: 'object',
      properties: { metric: { type: 'string', enum: TREND_METRICS.map((m) => m.key) }, window: { type: 'string', enum: [...TREND_WINDOWS] } },
      required: ['metric', 'window'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const t = await getMetricTrend(String(input.metric), { window: input.window as TrendWindow });
    if (!t) return { range: null, currency: 'CAD', fx: '', data: null, error: `unknown metric "${String(input.metric)}"` };
    return {
      range: rangeOut(t.span),
      currency: t.currency,
      fx: '',
      data: {
        metric: t.key,
        label: t.label,
        kind: t.kind,
        lowerIsBetter: t.lowerIsBetter,
        grain: t.grain,
        maturing: t.maturing,
        spanValue: t.spanValue,
        previousSpan: rangeOut(t.previousSpan),
        previousSpanValue: t.previousSpanValue,
        current: t.current.map((p) => ({ start: p.start, end: p.end, label: p.label, value: p.value })),
        previous: t.previous.map((p) => ({ start: p.start, end: p.end, label: p.label, value: p.value })),
      },
    };
  },
);

const listClientsTool = tool(
  {
    name: 'list_clients',
    description: 'Search the clients index (25 a page): name query, stage role, attribution class, an APPLICATION-date window. Date basis: appliedAt = the application date (F14). For "who applied / enrolled in a period" prefer get_stage_people, which uses the funnel\'s own membership.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name search; "" for none.' },
        attribution: { type: 'string', enum: ['any', 'paid', 'organic'], description: '"any" = both classes.' },
        from: { type: 'string', description: 'Applied on or after, YYYY-MM-DD; "" for no lower bound.' },
        to: { type: 'string', description: 'Applied on or before, YYYY-MM-DD; "" for no upper bound.' },
        page: PAGE_SCHEMA,
      },
      required: ['query', 'attribution', 'from', 'to', 'page'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const p = page(input);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const attribution = input.attribution === 'paid' || input.attribution === 'organic' ? input.attribution : null;
    const res = await listClients({ q: str(input.query), attribution, from: str(input.from), to: str(input.to), limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE });
    return {
      range: str(input.from) || str(input.to) ? { start: str(input.from) ?? '', end: str(input.to) ?? '', label: 'application date filter' } : null,
      currency: 'CAD',
      fx: '',
      data: {
        dateBasis: 'appliedAt is the application date (followed-pipeline opportunity created); from/to filter by it',
        page: p,
        pages: Math.max(1, Math.ceil(res.total / PAGE_SIZE)),
        total: res.total,
        rows: res.rows.map((r) => ({ id: r.id, name: r.name, stage: r.stageName, stageRole: r.stageRole, attribution: r.attributionClass, source: r.source, appliedAt: r.appliedAt, lastActivityAt: r.lastActivityAt, owner: r.owner, link: `/clients/${r.id}` })),
      },
    };
  },
);

const getClientTool = tool(
  {
    name: 'get_client',
    description: 'One person: name, pipeline stage and time in it, attribution class with its reason, contract value, and their timeline (stage changes, appointments, payments; newest first, up to 60). Never contact details.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'The FitFlow contact id (from a link like /clients/<id>).' } }, required: ['id'], additionalProperties: false },
  },
  async (input) => {
    const c = await getClientProfile(String(input.id));
    if (!c) return { range: null, currency: 'CAD', fx: '', data: null, error: `no client with id "${String(input.id)}"` };
    return {
      range: null,
      currency: c.contractCurrency,
      fx: '',
      data: {
        id: c.id,
        name: c.name,
        source: c.source,
        utmCampaign: c.utmCampaign,
        attributionClass: c.attributionClass,
        attributionReason: c.attributionReason,
        attributionClassSource: c.attributionClassSource,
        owner: c.owner,
        pipeline: c.pipelineName,
        stage: c.stageName,
        stageRole: c.stageRole,
        timeInStageHours: c.timeInStageHours,
        stageEnteredAt: c.stageEnteredAt,
        opportunityStatus: c.opportunityStatus,
        contractValueCents: c.monetaryValueCents,
        appliedAt: c.appliedAt,
        lastActivityAt: c.lastActivityAt,
        origin: c.origin,
        link: `/clients/${c.id}`,
        timeline: c.timeline.slice(0, 60).map((t) => ({ at: t.at, type: t.type, title: t.title, detail: t.detail, backfilled: t.backfilled })),
      },
    };
  },
);

const getDataHealthTool = tool(
  {
    name: 'get_data_health',
    description: 'What to caveat before advising: source freshness (stale sources by name), the scheduler, the last reconciliation, the maturing-data rule for this period, the Applied caveat with names, the daily Applied ledger (both definitions — the candidate is deferred #1 and NOT in use — and the Meta-to-FitFlow application ratio per campaign), applicants without a date, unattributed enrollments / cash, unclassified cash, unmatched payments, clients without a contract value, withheld show rates, and the owner-profile gaps. Call it before any recommendation.',
    input_schema: { type: 'object', properties: { range: RANGE_SCHEMA }, required: ['range'], additionalProperties: false },
  },
  async (input, ctx) => {
    const [res, status, profile, ledgerSummary, ratioSummary] = await Promise.all([getScorecard({ ...rangeParams(input.range as RangeInput), compare: 'previous_period' }), readSyncStatus(), getOwnerProfile(), readAppliedSummary(), readRatioSummary()]);
    const sc = res.scorecard;
    const gaps = profileGaps(profile);
    // The daily Applied ledger for the requested range (docs/plan-reconciliation-2026-09-30.md) — both definitions, names only.
    const ledgerRows = await db.select().from(appliedLedger).where(and(gte(appliedLedger.ledgerOn, res.range.start), lte(appliedLedger.ledgerOn, res.range.end)));
    const week = summarizeWeek(ledgerRows as unknown as LedgerRowInput[], { start: res.range.start, end: res.range.end, label: res.range.resolvedLabel });
    const appliedLedgerBlock = ledgerSummary
      ? {
          range: rangeOut(res.range),
          current: week.current,
          currentLabel: CURRENT_LABEL,
          candidate: week.candidate,
          candidateLabel: CANDIDATE_LABEL,
          byClass: Object.fromEntries((Object.keys(week.byClass) as ApplicationClass[]).map((k) => [k, { label: CLASS_LABELS[k], count: week.byClass[k].count }])),
          otherPipelines: ledgerRows.filter((r) => r.class === 'X').map((r) => ({ name: r.name, pipeline: r.pipelineName })),
          unresolved: week.unresolved,
          ledgerComputedAt: ledgerSummary.ranAt,
          mirrorAsOf: ledgerSummary.mirrorAsOf,
          ratio: ratioSummary ? { through: ratioSummary.through, metaDayTz: ratioSummary.metaDayTz, campaigns: ratioSummary.campaigns.map((c) => ({ campaign: c.campaignName, state: c.state, rolling7: c.rolling7, baseline: c.baseline, meta7: c.meta7, fitflow7: c.fitflow7, text: c.text })), unmatchedUtmRows: ratioSummary.unmatchedUtmRows } : null,
          definitionUnderReview: true,
          deferred: 'docs/deferred.md #1',
          note: 'Counts on the dashboard use the current definition. The candidate is what deferred #1 would count and is NOT in use — never present it as the number.',
        }
      : { notRunYet: true, note: 'The daily Applied ledger has not run yet (Setup → Reconciliation → Reconcile now).', definitionUnderReview: true, deferred: 'docs/deferred.md #1' };
    return {
      range: rangeOut(res.range),
      currency: res.money.currency,
      fx: res.money.fx.text,
      data: {
        freshness: ctx.freshness,
        scheduler: status.scheduler,
        reconcile: status.reconcile,
        maturity: { active: res.maturity.active, historyCompleteSince: res.maturity.historyCompleteSince, sunset: res.maturity.sunset, comparisonTouches: Boolean(res.maturity.comparisonTouches), affects: ['consults_booked', 'roadmaps_booked', 'cpl', 'cost_consult', 'cost_roadmap', 'every stage→stage conversion'] },
        appliedCaveat: { text: sc.appliedCaveat.text, applied: sc.appliedCaveat.applied, withoutFormRecord: sc.appliedCaveat.withoutFormRecord.map((p) => ({ name: p.name, reason: p.reason })), otherPipelines: sc.appliedCaveat.otherPipelines.map((p) => ({ name: p.name, pipeline: p.pipeline })), definitionUnderReview: true },
        applicantsWithoutDate: (res.inputHealth?.applicantsWithoutDate ?? []).map((a) => a.name),
        appliedFromMove: res.inputHealth?.appliedFromMove ?? 0,
        unattributedEnrollments: sc.marketing.unattributedEnrollments,
        unattributedInitialCents: sc.marketing.unattributedInitialCents,
        unattributedInitialCount: sc.marketing.unattributedInitialCount,
        unclassifiedCents: sc.revenue.unclassifiedCents,
        unclassifiedCount: sc.revenue.unclassifiedCount,
        unmatchedPayments: res.revenue.unmatchedCount,
        contractValueMissing: sc.marketing.contractValueMissing.map((c) => c.name),
        showRatesWithheld: sc.showRates.filter((s) => s.withheld).map((s) => ({ type: s.type, reason: s.withheld })),
        unsupportedMoneyRows: res.money.unsupportedRows,
        awaitingStripe: sc.revenue.awaitingStripe,
        noSpendData: sc.marketing.noSpendData,
        ownerProfileGaps: gaps,
        withheld: withheldLine(gaps),
        spendAdviceAllowed: !ctx.freshness.stale,
        appliedLedger: appliedLedgerBlock,
      },
    };
  },
);

const comparePeriodsTool = tool(
  {
    name: 'compare_periods',
    description: 'Two periods side by side: every KPI in both, with the absolute and percent change, and whether the comparison touches maturing history. Use for "vs last week / last month / August".',
    input_schema: { type: 'object', properties: { range: RANGE_SCHEMA, against: RANGE_SCHEMA }, required: ['range', 'against'], additionalProperties: false },
  },
  async (input) => {
    const [a, b] = await Promise.all([getScorecard({ ...rangeParams(input.range as RangeInput), compare: 'off' }), getScorecard({ ...rangeParams(input.against as RangeInput), compare: 'off' })]);
    const keys = Object.keys(a.scorecard.kpis) as Array<keyof typeof a.scorecard.kpis>;
    const rows = keys.map((k) => {
      const cur = a.scorecard.kpis[k].current;
      const prev = b.scorecard.kpis[k].current;
      const abs = cur === null || prev === null ? null : cur - prev;
      const pct = abs === null || prev === null || prev === 0 ? null : abs / Math.abs(prev);
      const metricKey = k === 'consultsBooked' ? 'consults_booked' : k === 'roadmapsBooked' ? 'roadmaps_booked' : k === 'costPerRoadmapCents' ? 'cost_roadmap' : k;
      return { kpi: k, current: cur, against: prev, abs, pct, maturing: isMaturingMetric(metricKey, a.maturity) || isMaturingMetric(metricKey, b.maturity) };
    });
    return {
      range: rangeOut(a.range),
      currency: a.money.currency,
      fx: a.money.fx.text,
      data: { against: rangeOut(b.range), kpis: rows, maturity: { rangeTouches: a.maturity.active, againstTouches: b.maturity.active, note: a.maturity.active || b.maturity.active ? 'One side touches incomplete stage history: the history-dependent rows are not a real change.' : null } },
    };
  },
);

const getNotesTool = tool(
  {
    name: 'get_notes',
    description: 'The owner profile (goals, offers, gross margin, targets, team), its gaps and what they withhold, the active owner notes (dated) and the decisions on record.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async () => {
    const [profile, notes] = await Promise.all([getOwnerProfile(), activeNotes()]);
    const gaps = profileGaps(profile);
    return {
      range: null,
      currency: 'CAD',
      fx: '',
      data: { profile, gaps, withheld: withheldLine(gaps), notes: notes.map((n) => ({ on: n.createdAt.toISOString().slice(0, 10), text: n.text })), decisions: DECISIONS_LOG },
    };
  },
);

const getMetricTool = tool(
  {
    name: 'get_metric',
    description: 'A metric\'s definition from the glossary (what it is, how it differs from its neighbours, the formula) and the formula worked with this period\'s engine numbers — the exact value the tile shows, or why it is withheld. Use it for "what does this mean" and before explaining any number.',
    input_schema: { type: 'object', properties: { key: { type: 'string', enum: [...GLOSSARY_KEYS] }, range: RANGE_SCHEMA, mode: MODE_SCHEMA }, required: ['key', 'range', 'mode'], additionalProperties: false },
  },
  async (input) => {
    const e = glossaryEntry(String(input.key));
    if (!e) return { range: null, currency: 'CAD', fx: '', data: null, error: `unknown metric key "${String(input.key)}"` };
    const { timezone, range } = await resolveRange(input.range as RangeInput);
    const metricsInput = await loadMetricsInput({ start: range.start, end: range.end, timezone });
    const w = e.worked(metricsInput, range, input.mode as 'period' | 'cohort');
    return {
      range: rangeOut(range),
      currency: w.currency,
      fx: '',
      data: { key: e.key, label: e.label, unit: e.unit, lowerIsBetter: e.lowerIsBetter, definition: e.definition, differsFrom: e.differsFrom, formula: e.formula, maturing: e.maturing, value: w.value, worked: w.text, reason: w.reason, inputs: w.inputs },
    };
  },
);

const getTodoTool = tool(
  {
    name: 'get_todo',
    description: 'Today\'s call list, as the daily email sends it: Day-1 and Day-3 buckets (applied with no consult booked, consult no-show, roadmap no-show) and everyone awaiting a rebook, by name with links.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async () => {
    const { today, buckets } = await getTodoBuckets();
    const people = (rows: Array<{ contactId: string; name: string; on: string; source: string | null }>) => rows.map((p) => ({ name: p.name, on: p.on, source: p.source, link: `/clients/${p.contactId}` }));
    return {
      range: { start: today, end: today, label: `today · ${today}` },
      currency: 'CAD',
      fx: '',
      data: {
        today,
        total: buckets.total,
        day1: Object.fromEntries(Object.entries(buckets.day1).map(([k, v]) => [k, { label: TODO_LABELS[k as keyof typeof TODO_LABELS], people: people(v) }])),
        day3: Object.fromEntries(Object.entries(buckets.day3).map(([k, v]) => [k, { label: TODO_LABELS[k as keyof typeof TODO_LABELS], people: people(v) }])),
        awaitingRebook: Object.fromEntries(Object.entries(buckets.awaitingRebook).map(([k, v]) => [k, { label: REBOOK_LABELS[k as keyof typeof REBOOK_LABELS], people: v.map((p) => ({ name: p.name, daysWaiting: p.daysWaiting, link: `/clients/${p.contactId}` })) }])),
      },
    };
  },
);

// ---------------------------------------------------------------------------
// calculate — typed arithmetic over refs, in integer cents; its result gets its own ref
// ---------------------------------------------------------------------------

export type CalcOp = 'difference' | 'percent_change' | 'ratio' | 'product' | 'sum' | 'per_unit';
/** An operand is a ref OR a literal — `kind` says which; the other field is ignored (no nullables, see RANGE_SCHEMA). */
const OPERAND_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['ref', 'value'], description: '"ref" = read the number from an earlier tool result; "value" = a literal.' },
    ref: { type: 'string', description: 'The ref (e.g. "r2:data.marketing.spendCents") when kind is "ref"; "" otherwise.' },
    value: { type: 'number', description: 'The literal when kind is "value"; 0 otherwise.' },
  },
  required: ['kind', 'ref', 'value'],
  additionalProperties: false,
} as const;
export type Operand = { kind: 'ref' | 'value'; ref: string; value: number };
const CALC_OPS: CalcOp[] = ['difference', 'percent_change', 'ratio', 'product', 'sum', 'per_unit'];
const RATIO_PATH = /(rate|roas|pct|share|conversion|ltvtocac|frequency|coverage)/i;
const CENTS_PATH = /cents/i;

export function calculate(op: CalcOp, a: Operand, b: Operand, resolve: ToolContext['resolveRef']): { value: number; unit: 'cents' | 'count' | 'ratio' | 'number'; text: string } {
  const operand = (o: Operand, name: string): { value: number; unit: 'cents' | 'ratio' | 'number' } => {
    if (o.kind === 'ref') {
      if (!o.ref) throw new Error(`${name}: kind is "ref" but ref is empty`);
      const v = resolve(o.ref);
      if (v === undefined) throw new Error(`${name}: unknown ref "${o.ref}" — cite a number from an earlier tool result in this conversation`);
      if (v === null) throw new Error(`${name}: ref "${o.ref}" is null (withheld) — there is nothing to compute`);
      return { value: v, unit: CENTS_PATH.test(o.ref) ? 'cents' : RATIO_PATH.test(o.ref) ? 'ratio' : 'number' };
    }
    if (typeof o.value === 'number' && Number.isFinite(o.value)) return { value: o.value, unit: 'number' };
    throw new Error(`${name}: give a ref or a numeric value`);
  };
  const x = operand(a, 'a');
  const y = operand(b, 'b');
  if ((op === 'sum' || op === 'difference') && x.unit === 'ratio' && y.unit === 'ratio') throw new Error('refused: do not add or average ratios — recompute from the totals (e.g. ratio of the summed numerators and denominators)');
  if ((op === 'sum' || op === 'difference') && x.unit !== y.unit && x.unit !== 'number' && y.unit !== 'number') throw new Error(`refused: ${op} of ${x.unit} and ${y.unit} mixes units`);
  const cents = x.unit === 'cents' || y.unit === 'cents';
  switch (op) {
    case 'sum':
      return out(x.value + y.value, cents ? 'cents' : x.unit === 'ratio' ? 'ratio' : 'number');
    case 'difference':
      return out(x.value - y.value, cents ? 'cents' : x.unit === 'ratio' ? 'ratio' : 'number');
    case 'percent_change':
      if (y.value === 0) throw new Error('percent_change: the base (b) is 0 — there is no percentage');
      return out((x.value - y.value) / Math.abs(y.value), 'ratio');
    case 'ratio':
      if (y.value === 0) throw new Error('ratio: b is 0');
      return out(x.value / y.value, x.unit === 'cents' && y.unit === 'cents' ? 'ratio' : x.unit === 'cents' ? 'cents' : 'number');
    case 'per_unit':
      if (y.value === 0) throw new Error('per_unit: b is 0');
      return out(x.unit === 'cents' ? Math.round(x.value / y.value) : x.value / y.value, x.unit === 'cents' ? 'cents' : 'number');
    case 'product':
      return out(x.value * y.value, cents ? 'cents' : x.unit === 'ratio' && y.unit === 'ratio' ? 'ratio' : 'number');
  }
  function out(value: number, unit: 'cents' | 'count' | 'ratio' | 'number') {
    const v = unit === 'cents' ? Math.round(value) : Math.round(value * 1e6) / 1e6;
    const text = unit === 'cents' ? money(v, 'CAD').replace(' CAD', '') : unit === 'ratio' ? (op === 'percent_change' ? formatPct(v, 1) : `${v.toFixed(4)}`) : String(v);
    return { value: v, unit, text };
  }
}

const calculateTool = tool(
  {
    name: 'calculate',
    description: 'Arithmetic over numbers you already fetched, by ref (e.g. "r2:data.marketing.spendCents"), so the result has a ref you can cite. Money stays in integer cents. Ops: difference (a−b), percent_change ((a−b)÷|b|), ratio (a÷b), product, sum, per_unit (a÷b rounded to cents). It refuses to add or average ratios: recompute from totals.',
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: CALC_OPS },
        a: OPERAND_SCHEMA,
        b: OPERAND_SCHEMA,
      },
      required: ['op', 'a', 'b'],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    try {
      const r = calculate(input.op as CalcOp, input.a as Operand, input.b as Operand, ctx.resolveRef);
      return { range: null, currency: 'CAD', fx: '', data: { op: input.op, a: input.a, b: input.b, value: r.value, unit: r.unit, text: r.text } };
    } catch (err) {
      return { range: null, currency: 'CAD', fx: '', data: null, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/** The fixed, name-sorted tool list. Never changes inside a thread (a change rebuilds the cache and drops old thinking). */
export const ANALYST_TOOLS: readonly AnalystTool[] = [
  calculateTool,
  comparePeriodsTool,
  getCampaignsTool,
  getClientTool,
  getDataHealthTool,
  getFunnelTool,
  getMetricTool,
  getNotesTool,
  getPaymentsTool,
  getRevenueTool,
  getScorecardTool,
  getStagePeopleTool,
  getTodoTool,
  getTrendTool,
  listClientsTool,
].sort((a, b) => a.definition.name.localeCompare(b.definition.name));

export const ANALYST_TOOL_DEFINITIONS: readonly BetaTool[] = ANALYST_TOOLS.map((t) => t.definition);

const BY_NAME = new Map(ANALYST_TOOLS.map((t) => [t.definition.name, t]));

/**
 * Run one tool call. Invalid input or a thrown function becomes an error RESULT the model can read
 * and correct; it never rejects the round and never returns an empty success. PII is scrubbed and the
 * result is size-capped.
 */
export async function runAnalystTool(name: string, input: unknown, ctx: ToolContext, tools: readonly AnalystTool[] = ANALYST_TOOLS): Promise<ToolResult> {
  const t = tools === ANALYST_TOOLS ? BY_NAME.get(name) : tools.find((x) => x.definition.name === name);
  const base = { ref: ctx.ref, freshness: ctx.freshness };
  if (!t) return { ...base, range: null, currency: 'CAD', fx: '', data: null, error: `unknown tool "${name}"` };
  // Validate against the tool's own JSON Schema (the tools are not strict): a bad input is a readable error result.
  const parsed = (t.validate ?? zodFromJsonSchema(t.definition.input_schema, name)).safeParse(input && typeof input === 'object' ? input : {});
  if (!parsed.success) return { ...base, range: null, currency: 'CAD', fx: '', data: null, error: `invalid input for ${name}: ${describeZodIssues(parsed.error)} — fix the input and call again (the schema is in the tool definition)` };
  const args = parsed.data as Record<string, unknown>;
  let result: Omit<ToolResult, 'ref' | 'freshness'>;
  try {
    result = await t.run(args, ctx);
  } catch (err) {
    return { ...base, range: null, currency: 'CAD', fx: '', data: null, error: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const scrubbed = scrubContact(result);
  const full: ToolResult = { ...base, ...scrubbed };
  const json = JSON.stringify(full);
  if (json.length <= MAX_RESULT_CHARS) return full;
  return truncateResult(full);
}

/** Cut the largest arrays until the result fits; say so. */
function truncateResult(r: ToolResult): ToolResult {
  const cut = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, Math.max(5, Math.floor(v.length / 2))).map(cut);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  let data = r.data;
  for (let i = 0; i < 6; i++) {
    data = cut(data);
    if (JSON.stringify({ ...r, data }).length <= MAX_RESULT_CHARS) break;
  }
  return { ...r, data, truncated: true, error: r.error ?? 'result truncated to fit — narrow the range or page through the list' };
}
