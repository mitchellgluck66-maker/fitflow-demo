/**
 * Metric glossary — THE single source of definitions (Analyst plan item 2,
 * 2026-09-30). One entry per metric the app shows: what it is in plain words,
 * how it differs from its neighbours, the formula in words, whether it is
 * history-dependent (maturing before 2026-09-01), and `worked(input, range)`:
 * the formula with this range's engine numbers, e.g.
 * "$3,697.68 CAD spend ÷ 4 paid enrollments = $924.42 CAD". `worked` calls
 * the same engine functions the pages call, so the value it returns IS the
 * number the tile renders (tests/glossary.test.ts proves it per key × range).
 *
 * Every consumer of a definition reads from here: the Ask / Insights prompts,
 * the Analyst's system contract, the "What does this mean?" formula box. The
 * old header comment in lib/metrics/index.ts is a pointer to this file.
 *
 * A metric whose inputs are missing returns `value: null` with the reason
 * (rule 8) — never a computed number.
 */

import {
  computeAdsKpis,
  computeCampaignTable,
  computeFunnel,
  computeMarketing,
  computeRevenue,
  computeRevenueSummary,
  computeShowRates,
  computeTimeInStage,
  formatCents,
  formatPct,
  FUNNEL_STAGES,
  inReportingCurrency,
  SHOW_RATE_MIN_COVERAGE,
  type Currency,
  type FunnelMode,
  type FunnelStageKey,
  type MetricsInput,
  type Range,
} from './index';
import { HISTORY_DEPENDENT_METRICS, HISTORY_DEPENDENT_STAGES } from './maturity';
import { DISPLAY_METRICS } from './display';
import { TREND_METRICS } from './trendMetrics';

/** Bump when a definition changes; stored reports carry it so older ones are labelled "pre-correction". */
export const METRIC_DEFINITION_VERSION = '2026-09-30';

export type GlossaryUnit = 'count' | 'cents' | 'pct' | 'ratio' | 'hours';
export type GlossaryGroup = 'money' | 'funnel' | 'conversion' | 'show_rate' | 'marketing' | 'campaign' | 'time';

export interface Worked {
  /** The engine's value for the range (cents / count / 0–1 ratio / hours), or null with `reason`. */
  value: number | null;
  /** The formula with the range's numbers filled in, or the reason it is withheld. */
  text: string;
  reason: string | null;
  currency: Currency;
  /** The inputs the formula used, by name — the Analyst cites these. */
  inputs: Record<string, number | null>;
}

export interface GlossaryEntry {
  key: string;
  label: string;
  group: GlossaryGroup;
  unit: GlossaryUnit;
  lowerIsBetter: boolean;
  /** Plain-English definition. */
  definition: string;
  /** How it differs from the metrics it is most often confused with. */
  differsFrom: string;
  /** The formula in words. */
  formula: string;
  /** History-dependent: under/over-counted for ranges before history_complete_since (lib/metrics/maturity.ts). */
  maturing: boolean;
  worked: (input: MetricsInput, range: Range, mode?: FunnelMode) => Worked;
}

const NOT_CONFIGURED_STRIPE = 'no Stripe payments have been synced yet';

function money(cents: number | null, ccy: Currency): string {
  return formatCents(cents, ccy);
}

function ratioText(r: number | null): string {
  return r === null ? '—' : `${r.toFixed(2)}×`;
}

function pctText(r: number | null): string {
  return formatPct(r, 1);
}

function withheld(reason: string, ccy: Currency, inputs: Record<string, number | null> = {}): Worked {
  return { value: null, text: `Withheld: ${reason}.`, reason, currency: ccy, inputs };
}

function ccyOf(input: MetricsInput): Currency {
  return inReportingCurrency(input).money.reporting;
}

const stageLabel = (k: FunnelStageKey) => FUNNEL_STAGES.find((s) => s.key === k)!.label.toLowerCase();

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const moneyEntries: GlossaryEntry[] = [
  {
    key: 'initial_cash',
    label: 'Initial cash collected',
    group: 'money',
    unit: 'cents',
    lowerIsBetter: false,
    definition: 'New-client cash: every Stripe customer\'s FIRST successful, not-fully-refunded charge that landed in the period, net of its refunds — whatever the rail (a subscription-only client\'s first invoice is still initial).',
    differsFrom: 'Cash collected includes recurring charges too; recurring cash is every later kept charge. ROAS uses only the PAID-attributed part of initial cash.',
    formula: 'Σ (amount − refunds) of payments classed initial dated in the period',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenue(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.initialCents, text: `${r.initialCount} initial payment${r.initialCount === 1 ? '' : 's'} net of refunds = ${money(r.initialCents, r.currency)}`, reason: null, currency: r.currency, inputs: { initialCount: r.initialCount, initialCents: r.initialCents } };
    },
  },
  {
    key: 'recurring_cash',
    label: 'Recurring cash',
    group: 'money',
    unit: 'cents',
    lowerIsBetter: false,
    definition: 'Every kept charge after a customer\'s first one, subscription invoices included, net of refunds, dated in the period.',
    differsFrom: 'Initial cash is the first charge only. MRR is the monthly-normalised value of subscriptions that are active now, not cash that arrived.',
    formula: 'Σ (amount − refunds) of payments classed recurring dated in the period',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenue(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.recurringCents, text: `${r.recurringCount} recurring payment${r.recurringCount === 1 ? '' : 's'} net of refunds = ${money(r.recurringCents, r.currency)}`, reason: null, currency: r.currency, inputs: { recurringCount: r.recurringCount, recurringCents: r.recurringCents } };
    },
  },
  {
    key: 'collected',
    label: 'Cash collected',
    group: 'money',
    unit: 'cents',
    lowerIsBetter: false,
    definition: 'All cash that arrived in the period, every class, net of refunds. Reconciles to Stripe: charged − refunded = collected.',
    differsFrom: 'Initial and recurring are its two classified parts; unclassified succeeded cash (a data-health warning) is in collected but in neither class.',
    formula: 'initial cash + recurring cash + unclassified succeeded cash',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenue(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.collectedCents, text: `${money(r.initialCents, r.currency)} initial + ${money(r.recurringCents, r.currency)} recurring${r.unclassifiedCents ? ` + ${money(r.unclassifiedCents, r.currency)} unclassified` : ''} = ${money(r.collectedCents, r.currency)}`, reason: null, currency: r.currency, inputs: { initialCents: r.initialCents, recurringCents: r.recurringCents, unclassifiedCents: r.unclassifiedCents, collectedCents: r.collectedCents } };
    },
  },
  {
    key: 'refunds',
    label: 'Refunds',
    group: 'money',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Money returned to customers in the period. A refund inherits its parent charge\'s customer; a fully refunded charge nets to zero in cash.',
    differsFrom: 'Failed payments were never collected, so they are not refunds.',
    formula: 'Σ refunded amount of charges dated in the period',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenue(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.refundedCents, text: `refunded in the period = ${money(r.refundedCents, r.currency)}`, reason: null, currency: r.currency, inputs: { refundedCents: r.refundedCents } };
    },
  },
  {
    key: 'failed',
    label: 'Still unpaid invoices',
    group: 'money',
    unit: 'count',
    lowerIsBetter: true,
    definition: 'Invoices whose latest payment attempt in the period failed and that have not been paid since. Counted once per invoice, not once per retry.',
    differsFrom: 'A failed attempt whose invoice was paid later is not owed and is not counted (it is reported separately as "failed, later paid").',
    formula: 'count of invoices with a failed latest attempt in the period and no later successful payment',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenue(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.failedCount, text: `${r.failedCount} invoice${r.failedCount === 1 ? '' : 's'} still unpaid`, reason: null, currency: r.currency, inputs: { failedCount: r.failedCount } };
    },
  },
  {
    key: 'mrr',
    label: 'MRR (Subscriptions)',
    group: 'money',
    unit: 'cents',
    lowerIsBetter: false,
    definition: 'Monthly recurring revenue: the monthly-normalised sum of every subscription that is active, trialing or past due right now. Not bound to the selected period.',
    differsFrom: 'Recurring cash is money that actually arrived in the period; MRR is the run rate of subscriptions that exist today.',
    formula: 'Σ (subscription amount normalised to one month) over active subscriptions',
    maturing: false,
    worked: (input, range) => {
      const r = computeRevenueSummary(input, range);
      if (r.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, r.currency);
      return { value: r.mrrCents, text: `${r.activeSubscriptions} active subscription${r.activeSubscriptions === 1 ? '' : 's'} normalised to a month = ${money(r.mrrCents, r.currency)}`, reason: null, currency: r.currency, inputs: { activeSubscriptions: r.activeSubscriptions, mrrCents: r.mrrCents } };
    },
  },
];

// ---------------------------------------------------------------------------
// Funnel stages + conversions
// ---------------------------------------------------------------------------

const STAGE_DEFINITIONS: Record<FunnelStageKey, { definition: string; differsFrom: string }> = {
  applied: {
    definition: 'People whose application (an opportunity created in the followed GoHighLevel pipeline) is dated in the period. Dated by the opportunity, never by the contact\'s creation date. The definition is under review (docs/deferred.md #1): the caveat says how many counted applications have no application-form record and how many form applicants sit in other pipelines, and Setup → Reconciliation shows every counted person by class under both the current and the candidate definition, with Meta\'s application count per campaign against FitFlow\'s.',
    differsFrom: 'Platform leads are what Meta reports; tracked applied is the subset whose utm_campaign matches a campaign.',
  },
  consult_booked: {
    definition: 'People who entered the consult-booked stage in the period (in-period mode), or applicants of the period who have reached it or any later stage (by cohort).',
    differsFrom: 'Consult showed is attendance at the consult; consults booked counts the booking.',
  },
  consult_showed: {
    definition: 'People with a consult appointment that showed in the period. Withheld and skipped by the conversion chain when attendance is not recorded.',
    differsFrom: 'The consult show rate is showed ÷ (showed + no-show); this is the count of people.',
  },
  roadmap_booked: {
    definition: 'People who entered the roadmap-booked stage in the period, or applicants of the period who reached it or any later stage (by cohort).',
    differsFrom: 'Cost per roadmap booked divides spend by this count.',
  },
  roadmap_showed: {
    definition: 'People with a roadmap appointment that showed in the period, or who entered the roadmap-showed role. Withheld when attendance is not recorded.',
    differsFrom: 'Enrolled is the sale; roadmap showed is attendance at the roadmap call.',
  },
  enrolled: {
    definition: 'People who entered the Enrolled stage in the period (a new client), or applicants of the period who have enrolled since (by cohort).',
    differsFrom: 'Initial cash is the money; enrollments are the people. Paid enrollments are the subset whose first touch was a paid ad.',
  },
};

const stageEntries: GlossaryEntry[] = FUNNEL_STAGES.map((s) => ({
  key: s.key,
  label: s.label,
  group: 'funnel' as const,
  unit: 'count' as const,
  lowerIsBetter: false,
  definition: STAGE_DEFINITIONS[s.key].definition,
  differsFrom: STAGE_DEFINITIONS[s.key].differsFrom,
  formula: s.key === 'applied' ? 'count of opportunities created in the followed pipeline, dated in the period' : `count of people who entered ${s.label.toLowerCase()} in the period (in-period) / applicants of the period who reached it or later (by cohort)`,
  maturing: HISTORY_DEPENDENT_STAGES.has(s.key),
  worked: (input, range, mode = 'period') => {
    const f = computeFunnel(input, range, mode);
    const stage = f.stages.find((x) => x.key === s.key)!;
    if (stage.withheld) return withheld(stage.withheld, f.currency, { count: null });
    const share = stage.shareOfApplied === null ? '' : ` · ${formatPct(stage.shareOfApplied)} of applied`;
    return { value: stage.count, text: `${stage.count} ${s.label.toLowerCase()} (${mode === 'cohort' ? 'applicants of the period who reached it' : 'in the period'})${share}`, reason: null, currency: f.currency, inputs: { count: stage.count, applied: f.stages[0].count } };
  },
}));

const CHAIN: Array<[FunnelStageKey, FunnelStageKey]> = [
  ['applied', 'consult_booked'],
  ['consult_booked', 'consult_showed'],
  ['consult_showed', 'roadmap_booked'],
  ['roadmap_booked', 'roadmap_showed'],
  ['roadmap_showed', 'enrolled'],
];

const conversionEntries: GlossaryEntry[] = CHAIN.map(([from, to]) => ({
  key: `conv_${from}_${to}`,
  label: `${stageLabel(from)} → ${stageLabel(to)}`,
  group: 'conversion' as const,
  unit: 'pct' as const,
  lowerIsBetter: false,
  definition: `The share of people at ${stageLabel(from)} who reached ${stageLabel(to)}. When ${stageLabel(from)} is withheld (attendance not recorded) the chip spans the gap and is measured against the previous recorded stage instead.`,
  differsFrom: 'By cohort the ratio can never exceed 100% (each stage is a subset of the one before). In-period ratios compare events of the period and are capped at 100% and flagged "capped".',
  formula: `${stageLabel(to)} count ÷ ${stageLabel(from)} count (or ÷ the nearest recorded earlier stage)`,
  maturing: HISTORY_DEPENDENT_STAGES.has(from) || HISTORY_DEPENDENT_STAGES.has(to),
  worked: (input, range, mode = 'period') => {
    const f = computeFunnel(input, range, mode);
    const stage = f.stages.find((x) => x.key === to)!;
    if (stage.withheld) return withheld(stage.withheld, f.currency);
    if (stage.conversionFromPrevious === null || !stage.conversionFrom) return withheld(`no ${stageLabel(stage.conversionFrom ?? from)} in the period, so the ratio has no denominator`, f.currency, { to: stage.count });
    const base = f.stages.find((x) => x.key === stage.conversionFrom)!;
    const capped = stage.capped ? ' (capped at 100%)' : '';
    return { value: stage.conversionFromPrevious, text: `${stage.count} ${stageLabel(to)} ÷ ${base.count} ${stageLabel(base.key)} = ${pctText(stage.conversionFromPrevious)}${capped}`, reason: null, currency: f.currency, inputs: { [to]: stage.count, [base.key]: base.count } };
  },
}));

const appliedToEnrolled: GlossaryEntry = {
  key: 'applied_to_enrolled',
  label: 'Applied → enrolled',
  group: 'conversion',
  unit: 'pct',
  lowerIsBetter: false,
  definition: 'The share of applicants who became clients — the ring on the Command Center strip (by cohort: applicants of the period who have enrolled since).',
  differsFrom: 'The stage-to-stage chips measure one step each; this is end to end.',
  formula: 'enrolled ÷ applied',
  maturing: false,
  worked: (input, range, mode = 'cohort') => {
    const f = computeFunnel(input, range, mode);
    const applied = f.stages[0].count;
    const enrolled = f.stages.find((s) => s.key === 'enrolled')!;
    if (applied === 0) return withheld('no applicants in the period', f.currency, { applied: 0, enrolled: enrolled.count });
    return { value: enrolled.shareOfApplied, text: `${enrolled.count} enrolled ÷ ${applied} applied = ${pctText(enrolled.shareOfApplied)}`, reason: null, currency: f.currency, inputs: { applied, enrolled: enrolled.count } };
  },
};

const previousLeads: GlossaryEntry = {
  key: 'previous_leads',
  label: 'Previous leads',
  group: 'funnel',
  unit: 'count',
  lowerIsBetter: false,
  definition: 'People parked in the previous-lead stage in the period — a row outside the stage chain. A contact whose first observed stage was previous lead never enters the stages above.',
  differsFrom: 'Not an application and never in any conversion.',
  formula: 'count of people who entered previous lead in the period',
  maturing: false,
  worked: (input, range) => {
    const f = computeFunnel(input, range, 'period');
    return { value: f.previousLeads.count, text: `${f.previousLeads.count} previous lead${f.previousLeads.count === 1 ? '' : 's'} parked in the period`, reason: null, currency: f.currency, inputs: { count: f.previousLeads.count } };
  },
};

// ---------------------------------------------------------------------------
// Show rates
// ---------------------------------------------------------------------------

const showRate = (key: string, type: 'Consult' | 'Roadmap'): GlossaryEntry => ({
  key,
  label: `${type} show rate`,
  group: 'show_rate',
  unit: 'pct',
  lowerIsBetter: false,
  definition: `Of the ${type.toLowerCase()} appointments in the period whose attendance was recorded, the share that showed. Withheld — never a fabricated 0% — while fewer than ${Math.round(SHOW_RATE_MIN_COVERAGE * 100)}% of past ${type.toLowerCase()}s have a recorded outcome.`,
  differsFrom: `${type} showed is the count of people; cancelled appointments are excluded from the rate but count toward coverage.`,
  formula: 'showed ÷ (showed + no-show), per appointment type',
  maturing: false,
  worked: (input, range) => {
    const ccy = ccyOf(input);
    const r = computeShowRates(input, range).find((x) => x.type === type);
    if (!r) return withheld(`no ${type.toLowerCase()} appointments in the period`, ccy, { showed: null, noShow: null });
    if (r.rate === null) return withheld(r.withheld ?? 'attendance not recorded', ccy, { showed: r.showed, noShow: r.noShow, past: r.past, undecided: r.undecided });
    return { value: r.rate, text: `${r.showed} showed ÷ (${r.showed} showed + ${r.noShow} no-show) = ${pctText(r.rate)} · attendance recorded for ${formatPct(r.coverage)} of ${r.past}`, reason: null, currency: ccy, inputs: { showed: r.showed, noShow: r.noShow, cancelled: r.cancelled, past: r.past } };
  },
});

// ---------------------------------------------------------------------------
// Marketing economics
// ---------------------------------------------------------------------------

const marketingEntries: GlossaryEntry[] = [
  {
    key: 'spend',
    label: 'Spend',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Ad spend in the period across platforms, in the reporting currency. API rows (Meta, Google) own their platform and date; a manual weekly entry is spread over its seven days and used only for dates the API does not cover.',
    differsFrom: 'Spend is the denominator of every cost-per and CAC figure and of ROAS.',
    formula: 'Σ daily spend rows in the period (API first, manual fallback), converted at each row\'s date',
    maturing: false,
    worked: (input, range) => {
      const k = computeAdsKpis(input, range);
      const parts = k.byPlatform.filter((p) => p.spendCents > 0).map((p) => `${p.platform} ${money(p.spendCents, k.currency)}`);
      return { value: k.spendCents, text: parts.length ? `${parts.join(' + ')} = ${money(k.spendCents, k.currency)}` : `no spend rows in the period = ${money(0, k.currency)}`, reason: null, currency: k.currency, inputs: { spendCents: k.spendCents } };
    },
  },
  {
    key: 'paid_cac',
    label: 'Paid CAC',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'What one paid-acquired client cost: spend divided by the enrollments whose contact is attribution-classed paid (a first touch with an fbclid/gclid or a paid source/medium).',
    differsFrom: 'Blended CAC divides the same spend by ALL enrollments, organic included, so it is always lower or equal. Organic and unclassified enrollments never enter Paid CAC; they surface as data-health counts.',
    formula: 'spend ÷ paid-attributed enrollments',
    maturing: false,
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      if (m.spendCents === 0) return withheld('no spend in the period', m.currency, { spendCents: 0, paidEnrollments: m.paidEnrollments });
      if (m.paidEnrollments === 0) return withheld(`no paid-attributed enrollments in the period (${m.enrollments} enrollment${m.enrollments === 1 ? '' : 's'}, ${m.organicEnrollments} organic, ${m.unattributedEnrollments} unclassified)`, m.currency, { spendCents: m.spendCents, paidEnrollments: 0 });
      return { value: m.paidCacCents, text: `${money(m.spendCents, m.currency)} spend ÷ ${m.paidEnrollments} paid enrollment${m.paidEnrollments === 1 ? '' : 's'} = ${money(m.paidCacCents, m.currency)}`, reason: null, currency: m.currency, inputs: { spendCents: m.spendCents, paidEnrollments: m.paidEnrollments } };
    },
  },
  {
    key: 'blended_cac',
    label: 'Blended CAC',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'What one client cost on average, whatever brought them: spend divided by every enrollment in the period, organic included.',
    differsFrom: 'Paid CAC counts only paid-attributed enrollments. Cost per client on the Ads tab is the same number.',
    formula: 'spend ÷ all enrollments',
    maturing: false,
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      if (m.spendCents === 0) return withheld('no spend in the period', m.currency, { spendCents: 0, enrollments: m.enrollments });
      if (m.enrollments === 0) return withheld('no enrollments in the period', m.currency, { spendCents: m.spendCents, enrollments: 0 });
      return { value: m.blendedCacCents, text: `${money(m.spendCents, m.currency)} spend ÷ ${m.enrollments} enrollment${m.enrollments === 1 ? '' : 's'} (${m.paidEnrollments} paid, ${m.organicEnrollments} organic) = ${money(m.blendedCacCents, m.currency)}`, reason: null, currency: m.currency, inputs: { spendCents: m.spendCents, enrollments: m.enrollments } };
    },
  },
  {
    key: 'roas',
    label: 'ROAS',
    group: 'marketing',
    unit: 'ratio',
    lowerIsBetter: false,
    definition: 'Return on ad spend: new-client cash from paid-attributed contacts divided by spend. Only initial cash counts, net of refunds; failed payments are excluded.',
    differsFrom: 'Organic clients\' cash and every recurring charge are left out. LTV:CAC uses contract value (what was sold), not cash collected.',
    formula: 'paid-attributed initial cash ÷ spend',
    maturing: false,
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      if (m.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, m.currency);
      if (m.spendCents === 0) return withheld('no spend in the period', m.currency, { spendCents: 0, paidInitialCents: m.paidInitialCents });
      return { value: m.roas, text: `${money(m.paidInitialCents, m.currency)} paid initial cash ÷ ${money(m.spendCents, m.currency)} spend = ${ratioText(m.roas)}`, reason: null, currency: m.currency, inputs: { paidInitialCents: m.paidInitialCents, spendCents: m.spendCents } };
    },
  },
  {
    key: 'ltv_cac',
    label: 'LTV:CAC',
    group: 'marketing',
    unit: 'ratio',
    lowerIsBetter: false,
    definition: 'Contract value sold per dollar of spend: the total GoHighLevel opportunity value of the period\'s new clients divided by spend (equal to average contract value ÷ Blended CAC). Withheld, with the clients listed, while any new client has no contract value.',
    differsFrom: 'ROAS is cash that actually arrived; LTV:CAC is the value of what was sold.',
    formula: 'Σ contract value of new clients ÷ spend',
    maturing: false,
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      if (m.spendCents === 0) return withheld('no spend in the period', m.currency, { contractValueCents: m.contractValueCents, spendCents: 0 });
      if (m.contractValueMissing.length) return withheld(`${m.contractValueMissing.length} new client${m.contractValueMissing.length === 1 ? ' has' : 's have'} no contract value (${m.contractValueMissing.map((c) => c.name).join(', ')})`, m.currency, { contractValueCents: m.contractValueCents, spendCents: m.spendCents });
      if (m.enrollments === 0) return withheld('no enrollments in the period', m.currency, { contractValueCents: 0, spendCents: m.spendCents });
      return { value: m.ltvToCac, text: `${money(m.contractValueCents, m.currency)} contract value of ${m.enrollments} new client${m.enrollments === 1 ? '' : 's'} ÷ ${money(m.spendCents, m.currency)} spend = ${ratioText(m.ltvToCac)}`, reason: null, currency: m.currency, inputs: { contractValueCents: m.contractValueCents, enrollments: m.enrollments, spendCents: m.spendCents } };
    },
  },
  {
    key: 'cost_roadmap',
    label: 'Cost per roadmap booked',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Spend divided by the people who reached roadmap booked in the period.',
    differsFrom: 'Cost per consult divides by consults booked; cost per client by enrollments.',
    formula: 'spend ÷ roadmaps booked',
    maturing: HISTORY_DEPENDENT_METRICS.has('cost_roadmap'),
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      const roadmaps = computeFunnel(input, range, 'period').stages.find((s) => s.key === 'roadmap_booked')!.count;
      if (m.spendCents === 0) return withheld('no spend in the period', m.currency, { spendCents: 0, roadmapsBooked: roadmaps });
      if (roadmaps === 0) return withheld('no roadmaps booked in the period', m.currency, { spendCents: m.spendCents, roadmapsBooked: 0 });
      return { value: m.costPerRoadmapCents, text: `${money(m.spendCents, m.currency)} spend ÷ ${roadmaps} roadmap${roadmaps === 1 ? '' : 's'} booked = ${money(m.costPerRoadmapCents, m.currency)}`, reason: null, currency: m.currency, inputs: { spendCents: m.spendCents, roadmapsBooked: roadmaps } };
    },
  },
  {
    key: 'cpl',
    label: 'Cost per lead (CPL)',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Spend divided by applied (FitFlow-tracked applications, not platform-reported leads).',
    differsFrom: 'Meta\'s own cost per result uses its lead count, which can be about twice FitFlow\'s applied (see the Applied reconciliation).',
    formula: 'spend ÷ applied',
    maturing: HISTORY_DEPENDENT_METRICS.has('cpl'),
    worked: (input, range) => {
      const k = computeAdsKpis(input, range);
      const applied = computeFunnel(input, range, 'period').stages[0].count;
      if (k.spendCents === 0) return withheld('no spend in the period', k.currency, { spendCents: 0, applied });
      if (applied === 0) return withheld('no applications in the period', k.currency, { spendCents: k.spendCents, applied: 0 });
      return { value: k.costPerLeadCents, text: `${money(k.spendCents, k.currency)} spend ÷ ${applied} applied = ${money(k.costPerLeadCents, k.currency)}`, reason: null, currency: k.currency, inputs: { spendCents: k.spendCents, applied } };
    },
  },
  {
    key: 'cost_consult',
    label: 'Cost per consult',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Spend divided by consults booked in the period.',
    differsFrom: 'Cost per lead divides by applied; cost per roadmap by roadmaps booked.',
    formula: 'spend ÷ consults booked',
    maturing: HISTORY_DEPENDENT_METRICS.has('cost_consult'),
    worked: (input, range) => {
      const k = computeAdsKpis(input, range);
      const consults = computeFunnel(input, range, 'period').stages.find((s) => s.key === 'consult_booked')!.count;
      if (k.spendCents === 0) return withheld('no spend in the period', k.currency, { spendCents: 0, consultsBooked: consults });
      if (consults === 0) return withheld('no consults booked in the period', k.currency, { spendCents: k.spendCents, consultsBooked: 0 });
      return { value: k.costPerConsultCents, text: `${money(k.spendCents, k.currency)} spend ÷ ${consults} consult${consults === 1 ? '' : 's'} booked = ${money(k.costPerConsultCents, k.currency)}`, reason: null, currency: k.currency, inputs: { spendCents: k.spendCents, consultsBooked: consults } };
    },
  },
  {
    key: 'contract_value',
    label: 'Contract value of new clients',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: false,
    definition: 'The sum of the GoHighLevel opportunity value of the period\'s new clients — what was sold, in the contract-value currency converted to the reporting currency.',
    differsFrom: 'Initial cash is what was collected; contract value is the deal size.',
    formula: 'Σ opportunity value of enrolled contacts of the period',
    maturing: false,
    worked: (input, range) => {
      const m = computeMarketing(input, range);
      const missing = m.contractValueMissing.length ? ` · ${m.contractValueMissing.length} without a value` : '';
      return { value: m.contractValueCents, text: `${m.enrollments} new client${m.enrollments === 1 ? '' : 's'} = ${money(m.contractValueCents, m.currency)}${missing}`, reason: null, currency: m.currency, inputs: { enrollments: m.enrollments, contractValueCents: m.contractValueCents, missing: m.contractValueMissing.length } };
    },
  },
];

// ---------------------------------------------------------------------------
// Campaign-table columns (worked = the totals row over every campaign in range)
// ---------------------------------------------------------------------------

type CampaignTotals = { spendCents: number; impressions: number; reach: number; linkClicks: number; clicks: number; landingPageViews: number; platformLeads: number; purchases: number; initialCents: number; apiSpendCents: number; tracked: Record<FunnelStageKey, number>; currency: Currency; awaitingStripe: boolean };

function campaignTotals(input: MetricsInput, range: Range): CampaignTotals {
  const rows = computeCampaignTable(input, range);
  const t: CampaignTotals = { spendCents: 0, impressions: 0, reach: 0, linkClicks: 0, clicks: 0, landingPageViews: 0, platformLeads: 0, purchases: 0, initialCents: 0, apiSpendCents: 0, tracked: { applied: 0, consult_booked: 0, consult_showed: 0, roadmap_booked: 0, roadmap_showed: 0, enrolled: 0 }, currency: ccyOf(input), awaitingStripe: computeRevenue(input, range).awaitingStripe };
  for (const r of rows) {
    t.spendCents += r.spendCents;
    t.impressions += r.impressions;
    t.reach += r.reach;
    t.linkClicks += r.linkClicks;
    t.clicks += r.clicks;
    t.landingPageViews += r.landingPageViews;
    t.platformLeads += r.platformLeads;
    t.purchases += r.purchases;
    t.initialCents += r.initialCents;
    if (r.from === 'api') t.apiSpendCents += r.spendCents;
    for (const k of Object.keys(t.tracked) as FunnelStageKey[]) t.tracked[k] += r.tracked[k];
  }
  return t;
}

const platformCount = (key: string, label: string, field: keyof Pick<CampaignTotals, 'impressions' | 'reach' | 'linkClicks' | 'clicks' | 'landingPageViews' | 'platformLeads' | 'purchases'>, definition: string, differsFrom: string): GlossaryEntry => ({
  key,
  label,
  group: 'campaign',
  unit: 'count',
  lowerIsBetter: false,
  definition,
  differsFrom,
  formula: `Σ ${label.toLowerCase()} the platform reported for the period's campaigns`,
  maturing: false,
  worked: (input, range) => {
    const t = campaignTotals(input, range);
    return { value: t[field], text: `${t[field].toLocaleString('en-US')} ${label.toLowerCase()} across the period's campaigns`, reason: null, currency: t.currency, inputs: { [field]: t[field] } };
  },
});

const trackedCount = (key: string, stage: FunnelStageKey, label: string): GlossaryEntry => ({
  key,
  label,
  group: 'campaign',
  unit: 'count',
  lowerIsBetter: false,
  definition: `People at ${stageLabel(stage)} in the period whose contact's utm_campaign matches a campaign — FitFlow-tracked, not platform-reported. A campaign with no matched applicant shows "not tracked yet".`,
  differsFrom: `${FUNNEL_STAGES.find((s) => s.key === stage)!.label} on the funnel counts everyone; this counts only contacts matched to a campaign by utm_campaign.`,
  formula: `count of ${stageLabel(stage)} contacts with a matching utm_campaign`,
  maturing: HISTORY_DEPENDENT_STAGES.has(stage),
  worked: (input, range) => {
    const t = campaignTotals(input, range);
    return { value: t.tracked[stage], text: `${t.tracked[stage]} ${stageLabel(stage)} matched to a campaign by utm_campaign`, reason: null, currency: t.currency, inputs: { tracked: t.tracked[stage] } };
  },
});

const campaignEntries: GlossaryEntry[] = [
  platformCount('impressions', 'Impressions', 'impressions', 'Times an ad was shown, as the platform reports it.', 'Reach is distinct people; impressions count repeat views.'),
  platformCount('reach', 'Reach', 'reach', 'Distinct people who saw an ad (Meta).', 'Impressions ÷ reach is frequency.'),
  {
    key: 'frequency',
    label: 'Frequency',
    group: 'campaign',
    unit: 'ratio',
    lowerIsBetter: true,
    definition: 'How many times, on average, each person reached saw an ad. Re-derived from the totals, never averaged across campaigns.',
    differsFrom: 'A rising frequency with a flat reach is creative fatigue, not growth.',
    formula: 'impressions ÷ reach',
    maturing: false,
    worked: (input, range) => {
      const t = campaignTotals(input, range);
      if (t.reach === 0) return withheld('no reach reported in the period', t.currency, { impressions: t.impressions, reach: 0 });
      const v = Math.round((t.impressions / t.reach) * 100) / 100;
      return { value: v, text: `${t.impressions.toLocaleString('en-US')} impressions ÷ ${t.reach.toLocaleString('en-US')} reach = ${v.toFixed(2)}`, reason: null, currency: t.currency, inputs: { impressions: t.impressions, reach: t.reach } };
    },
  },
  {
    key: 'cpm',
    label: 'CPM',
    group: 'campaign',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Spend per 1,000 impressions, re-derived from the period\'s totals.',
    differsFrom: 'CPC is spend per link click; CPL is spend per applied.',
    formula: 'spend ÷ impressions × 1,000',
    maturing: false,
    worked: (input, range) => {
      const t = campaignTotals(input, range);
      if (t.impressions === 0) return withheld('no impressions reported in the period', t.currency, { spendCents: t.spendCents, impressions: 0 });
      const v = Math.round((t.spendCents / t.impressions) * 1000);
      return { value: v, text: `${money(t.spendCents, t.currency)} spend ÷ ${t.impressions.toLocaleString('en-US')} impressions × 1,000 = ${money(v, t.currency)}`, reason: null, currency: t.currency, inputs: { spendCents: t.spendCents, impressions: t.impressions } };
    },
  },
  platformCount('link_clicks', 'Link clicks', 'linkClicks', 'Clicks that left the platform (Meta inline link clicks).', 'Clicks (all) includes reactions, expands and profile clicks.'),
  platformCount('clicks', 'Clicks (all)', 'clicks', 'Every click the platform counts, including reactions and expands.', 'Link clicks are the subset that went to the landing page.'),
  {
    key: 'cpc',
    label: 'CPC',
    group: 'campaign',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'Spend per link click, re-derived from the period\'s totals.',
    differsFrom: 'CPM is per 1,000 impressions; CPL is per applied.',
    formula: 'spend ÷ link clicks',
    maturing: false,
    worked: (input, range) => {
      const t = campaignTotals(input, range);
      if (t.linkClicks === 0) return withheld('no link clicks reported in the period', t.currency, { spendCents: t.spendCents, linkClicks: 0 });
      const v = Math.round(t.spendCents / t.linkClicks);
      return { value: v, text: `${money(t.spendCents, t.currency)} spend ÷ ${t.linkClicks.toLocaleString('en-US')} link clicks = ${money(v, t.currency)}`, reason: null, currency: t.currency, inputs: { spendCents: t.spendCents, linkClicks: t.linkClicks } };
    },
  },
  platformCount('landing_page_views', 'Landing page views', 'landingPageViews', 'Meta landing_page_view actions: the page finished loading after a click.', 'Link clicks include clicks that never loaded the page.'),
  platformCount('platform_leads', 'Platform leads', 'platformLeads', 'Leads as the platform reports them (Meta lead / submit-application actions).', 'FitFlow\'s applied is the pipeline\'s count; Meta\'s can be about twice it (pixel double-fires under review).'),
  platformCount('purchases', 'Platform purchases', 'purchases', 'Purchase actions the platform attributes to the campaign.', 'Enrollments (tracked) are FitFlow\'s own count of new clients matched to the campaign.'),
  trackedCount('tracked_applied', 'applied', 'Applied (tracked)'),
  trackedCount('tracked_consults', 'consult_booked', 'Consults (tracked)'),
  trackedCount('tracked_roadmaps', 'roadmap_booked', 'Roadmaps (tracked)'),
  trackedCount('tracked_enrolled', 'enrolled', 'Enrolled (tracked)'),
  {
    key: 'tracked_roas',
    label: 'ROAS (tracked)',
    group: 'campaign',
    unit: 'ratio',
    lowerIsBetter: false,
    definition: 'Per campaign: initial cash from contacts matched to the campaign by utm_campaign ÷ the campaign\'s spend. The totals row here is Σ matched initial cash ÷ Σ API spend.',
    differsFrom: 'The dashboard ROAS uses attribution class (paid vs organic), not utm_campaign matching, so the two can differ.',
    formula: 'matched initial cash ÷ campaign spend',
    maturing: false,
    worked: (input, range) => {
      const t = campaignTotals(input, range);
      if (t.awaitingStripe) return withheld(NOT_CONFIGURED_STRIPE, t.currency);
      if (t.apiSpendCents === 0) return withheld('no API-reported campaign spend in the period', t.currency, { initialCents: t.initialCents, spendCents: 0 });
      const v = t.initialCents / t.apiSpendCents;
      return { value: v, text: `${money(t.initialCents, t.currency)} matched initial cash ÷ ${money(t.apiSpendCents, t.currency)} campaign spend = ${ratioText(v)}`, reason: null, currency: t.currency, inputs: { initialCents: t.initialCents, spendCents: t.apiSpendCents } };
    },
  },
  {
    key: 'cost_client',
    label: 'Cost per client',
    group: 'marketing',
    unit: 'cents',
    lowerIsBetter: true,
    definition: 'The Ads-tab name for Blended CAC: spend divided by every enrollment in the period.',
    differsFrom: 'Identical to Blended CAC. Paid CAC uses paid-attributed enrollments only.',
    formula: 'spend ÷ all enrollments',
    maturing: false,
    worked: (input, range) => marketingEntries.find((e) => e.key === 'blended_cac')!.worked(input, range),
  },
];

// ---------------------------------------------------------------------------
// Time in stage
// ---------------------------------------------------------------------------

const TIME_ROLES: Array<{ role: FunnelStageKey; label: string }> = [
  { role: 'applied', label: 'Time in Applied' },
  { role: 'consult_booked', label: 'Time in Consult booked' },
  { role: 'consult_showed', label: 'Time in Consult showed' },
  { role: 'roadmap_booked', label: 'Time in Roadmap booked' },
  { role: 'roadmap_showed', label: 'Time in Roadmap showed' },
];

const timeEntries: GlossaryEntry[] = TIME_ROLES.map(({ role, label }) => ({
  key: `time_in_${role}`,
  label,
  group: 'time' as const,
  unit: 'hours' as const,
  lowerIsBetter: true,
  definition: `Median hours contacts spent in ${stageLabel(role)} before moving on, over every exit from the stage that happened in the period (paired with that contact's most recent entry, any date).`,
  differsFrom: 'The mean is pulled up by a few long stays; the median is the typical stay. People still in the stage are not counted.',
  formula: `median of (exit time − entry time) for exits from ${stageLabel(role)} in the period`,
  maturing: true,
  worked: (input, range) => {
    const ccy = ccyOf(input);
    const t = computeTimeInStage(input, range).find((x) => x.role === role);
    if (!t || t.samples === 0 || t.medianHours === null) return withheld(`no exits from ${stageLabel(role)} in the period`, ccy, { samples: t?.samples ?? 0 });
    return { value: t.medianHours, text: `median of ${t.samples} exit${t.samples === 1 ? '' : 's'} = ${t.medianHours.toFixed(1)} h (mean ${t.meanHours?.toFixed(1) ?? '—'} h)`, reason: null, currency: ccy, inputs: { samples: t.samples, medianHours: t.medianHours, meanHours: t.meanHours } };
  },
}));

// ---------------------------------------------------------------------------

/** The KPI-tile keys for the stage counts (in-period): the same definitions under the tile's key. */
const tileAlias = (key: string, stage: FunnelStageKey, label: string): GlossaryEntry => {
  const base = stageEntries.find((e) => e.key === stage)!;
  return { ...base, key, label, definition: `${label}: ${base.definition}`, differsFrom: `Same definition as the funnel's ${base.label} stage in in-period mode; the funnel strip on the Command Center shows the cohort count, which can differ.`, worked: (input, range) => base.worked(input, range, 'period') };
};

export const GLOSSARY: readonly GlossaryEntry[] = [
  ...moneyEntries,
  ...stageEntries,
  tileAlias('enrollments', 'enrolled', 'Enrollments'),
  tileAlias('consults_booked', 'consult_booked', 'Consults booked'),
  tileAlias('roadmaps_booked', 'roadmap_booked', 'Roadmaps booked'),
  previousLeads,
  ...conversionEntries,
  appliedToEnrolled,
  showRate('consult_show_rate', 'Consult'),
  showRate('roadmap_show_rate', 'Roadmap'),
  ...marketingEntries,
  ...campaignEntries,
  ...timeEntries,
];

const BY_KEY = new Map(GLOSSARY.map((e) => [e.key, e]));

export function glossaryEntry(key: string): GlossaryEntry | null {
  return BY_KEY.get(key) ?? null;
}

export const GLOSSARY_KEYS: readonly string[] = GLOSSARY.map((e) => e.key);

/**
 * The definitions as prompt text (Ask, Insights, the Analyst contract read this;
 * nobody restates a formula by hand). Sorted by group, one line per metric.
 */
export function glossaryText(keys?: readonly string[]): string {
  const entries = keys ? keys.map((k) => BY_KEY.get(k)).filter((e): e is GlossaryEntry => Boolean(e)) : GLOSSARY;
  return entries.map((e) => `- ${e.label} (${e.key}): ${e.definition} Formula: ${e.formula}.${e.maturing ? ' History-dependent: maturing before the history-complete date.' : ''}`).join('\n');
}

/** Sanity used by tests and the catalog check: every registered UI key has a glossary entry. */
export function missingGlossaryKeys(): string[] {
  const wanted = new Set<string>([...TREND_METRICS.map((m) => m.key), ...DISPLAY_METRICS.map((m) => m.key), ...FUNNEL_STAGES.map((s) => s.key)]);
  return [...wanted].filter((k) => !BY_KEY.has(k));
}
