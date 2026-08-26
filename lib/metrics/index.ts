/**
 * Metrics engine — PURE functions over (rows, dateRange) (CLAUDE.md rule 3).
 *
 * No database access in here. `lib/metrics/load.ts` fetches rows for a range
 * (plus comparison + trailing baseline) and hands them to these functions.
 * The Command Center, the Funnel tab, the emails and the AI layer all call the
 * SAME functions, so they can never disagree.
 *
 * Definitions (an "event in range" means its local calendar date, in the
 * business timezone, falls inside the inclusive range):
 *   applied          contacts whose GHL contact was created in range
 *   consult_booked   contacts who ENTERED the consult_booked role in range
 *   consult_showed   contacts with a Consult appointment that showed in range
 *   roadmap_booked   contacts who entered roadmap_booked in range
 *   roadmap_showed   contacts with a Roadmap appointment that showed in range
 *                    (or who entered the roadmap_showed role in range)
 *   enrolled         contacts who entered the enrolled role in range
 *   show rate        showed ÷ (showed + no-show), per appointment type
 *   cost per client  spend in range ÷ enrolled in range (null when 0 enrolled)
 *   ROAS             revenue collected in range ÷ spend in range
 *
 * Money is integer cents everywhere.
 */

import type { SemanticRole } from '@/db/schema';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  source: string | null;
  /** Current stage id/name/role. */
  stageId: string | null;
  stageName: string | null;
  role: SemanticRole | null;
  /** Local calendar date the contact was created in GHL (the "applied" moment). */
  appliedOn: string | null;
  monetaryValueCents: number;
  origin: string;
}

export interface TransitionRow {
  contactId: string;
  fromRole: SemanticRole | null;
  toRole: SemanticRole | null;
  toStageId: string | null;
  /** Local calendar date. */
  on: string;
  /** Epoch ms, for time-in-stage. */
  atMs: number;
}

export interface AppointmentRow {
  contactId: string | null;
  /** Consult | Roadmap | Follow-Up | Check-In */
  type: string;
  /** showed | no_show | cancelled | null */
  outcome: string | null;
  /** Local calendar date. */
  on: string;
  atMs: number;
}

export interface SpendRow {
  /** Local calendar date the spend applies to (week start for manual rows). */
  date: string;
  platform: string;
  spendCents: number;
  /** 'manual' rows are superseded by API rows for the same week (Phase C). */
  origin: string;
}

export interface PaymentRow {
  contactId: string | null;
  amountCents: number;
  refundedCents: number;
  status: string;
  /** Local calendar date. */
  on: string | null;
  origin: string;
}

export interface MetricsInput {
  contacts: ContactRow[];
  transitions: TransitionRow[];
  appointments: AppointmentRow[];
  spend: SpendRow[];
  payments: PaymentRow[];
}

export interface Range {
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelStageKey =
  | 'applied'
  | 'consult_booked'
  | 'consult_showed'
  | 'roadmap_booked'
  | 'roadmap_showed'
  | 'enrolled';

export const FUNNEL_STAGES: Array<{ key: FunnelStageKey; label: string; shortLabel: string }> = [
  { key: 'applied', label: 'Applied', shortLabel: 'app' },
  { key: 'consult_booked', label: 'Consult booked', shortLabel: 'booked' },
  { key: 'consult_showed', label: 'Consult showed', shortLabel: 'show' },
  { key: 'roadmap_booked', label: 'Roadmap booked', shortLabel: 'booked' },
  { key: 'roadmap_showed', label: 'Roadmap showed', shortLabel: 'show' },
  { key: 'enrolled', label: 'Enrolled', shortLabel: 'client' },
];

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  count: number;
  /** Distinct contact ids — powers the "who are these people" drawer. */
  contactIds: string[];
  /** count ÷ applied count (0..1), null when applied is 0. */
  shareOfApplied: number | null;
  /** count ÷ previous stage count (0..1), null when previous is 0. */
  conversionFromPrevious: number | null;
  /** previous.count − count (never negative). */
  dropOff: number;
  /** spend ÷ count in cents, null when count is 0 or no spend. */
  costPerCents: number | null;
}

export interface Funnel {
  range: Range;
  stages: FunnelStage[];
  spendCents: number;
}

function inRange(on: string | null, range: Range): boolean {
  return on !== null && on >= range.start && on <= range.end;
}

function uniq(ids: Iterable<string>): string[] {
  return Array.from(new Set(ids));
}

/** Contact ids per funnel stage for the range. */
export function funnelMembership(input: MetricsInput, range: Range): Record<FunnelStageKey, string[]> {
  const applied = input.contacts.filter((c) => inRange(c.appliedOn, range)).map((c) => c.id);

  const entered = (role: SemanticRole) =>
    input.transitions.filter((t) => t.toRole === role && inRange(t.on, range)).map((t) => t.contactId);

  const showed = (type: string) =>
    input.appointments
      .filter((a) => a.contactId && a.type === type && a.outcome === 'showed' && inRange(a.on, range))
      .map((a) => a.contactId as string);

  return {
    applied: uniq(applied),
    consult_booked: uniq(entered('consult_booked')),
    consult_showed: uniq(showed('Consult')),
    roadmap_booked: uniq(entered('roadmap_booked')),
    roadmap_showed: uniq([...showed('Roadmap'), ...entered('roadmap_showed')]),
    enrolled: uniq(entered('enrolled')),
  };
}

export function computeSpend(spend: SpendRow[], range: Range): number {
  // Phase C rule: when an API row (meta/google) exists for a week, manual rows
  // for the same platform+week are ignored. Manual-only today.
  const apiWeeks = new Set(spend.filter((s) => s.origin !== 'manual' && s.origin !== 'demo').map((s) => `${s.platform}:${weekOf(s.date)}`));
  return spend
    .filter((s) => inRange(s.date, range))
    .filter((s) => !(s.origin === 'manual' && apiWeeks.has(`${s.platform}:${weekOf(s.date)}`)))
    .reduce((sum, s) => sum + s.spendCents, 0);
}

/** Sunday of the Sun–Sat week containing a YYYY-MM-DD (duplicated here to stay dependency-free). */
function weekOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}

export function computeFunnel(input: MetricsInput, range: Range): Funnel {
  const members = funnelMembership(input, range);
  const spendCents = computeSpend(input.spend, range);
  const appliedCount = members.applied.length;

  const stages: FunnelStage[] = [];
  for (const [i, def] of FUNNEL_STAGES.entries()) {
    const ids = members[def.key];
    const count = ids.length;
    const prev = i === 0 ? null : stages[i - 1];
    stages.push({
      key: def.key,
      label: def.label,
      count,
      contactIds: ids,
      shareOfApplied: appliedCount > 0 ? count / appliedCount : null,
      conversionFromPrevious: prev ? (prev.count > 0 ? count / prev.count : null) : null,
      dropOff: prev ? Math.max(0, prev.count - count) : 0,
      costPerCents: count > 0 && spendCents > 0 ? Math.round(spendCents / count) : null,
    });
  }

  return { range, stages, spendCents };
}

// ---------------------------------------------------------------------------
// Rates, CAC, revenue
// ---------------------------------------------------------------------------

export interface ShowRate {
  type: string;
  showed: number;
  noShow: number;
  cancelled: number;
  /** showed ÷ (showed + noShow), null when nothing decided. */
  rate: number | null;
}

export function computeShowRates(input: MetricsInput, range: Range): ShowRate[] {
  const byType = new Map<string, ShowRate>();
  for (const a of input.appointments) {
    if (!inRange(a.on, range)) continue;
    if (!byType.has(a.type)) byType.set(a.type, { type: a.type, showed: 0, noShow: 0, cancelled: 0, rate: null });
    const t = byType.get(a.type)!;
    if (a.outcome === 'showed') t.showed += 1;
    else if (a.outcome === 'no_show') t.noShow += 1;
    else if (a.outcome === 'cancelled') t.cancelled += 1;
  }
  return Array.from(byType.values())
    .map((t) => ({ ...t, rate: t.showed + t.noShow > 0 ? t.showed / (t.showed + t.noShow) : null }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

export interface Cac {
  spendCents: number;
  enrollments: number;
  /** spend ÷ enrollments in cents; null when no enrollments. */
  cacCents: number | null;
  /** True when there is no spend data at all for the range. */
  noSpendData: boolean;
}

export function computeCac(input: MetricsInput, range: Range): Cac {
  const spendCents = computeSpend(input.spend, range);
  const enrollments = funnelMembership(input, range).enrolled.length;
  return {
    spendCents,
    enrollments,
    cacCents: enrollments > 0 && spendCents > 0 ? Math.round(spendCents / enrollments) : null,
    noSpendData: !input.spend.some((s) => inRange(s.date, range)),
  };
}

export interface Revenue {
  /** Sum of succeeded payments minus refunds, in range. */
  collectedCents: number;
  paymentCount: number;
  failedCount: number;
  refundedCents: number;
  /** collected ÷ spend; null when either side is missing. */
  roas: number | null;
  /** No Stripe data has ever been synced → show "awaiting Stripe", never 0. */
  awaitingStripe: boolean;
}

export function computeRevenue(input: MetricsInput, range: Range): Revenue {
  const awaitingStripe = !input.payments.some((p) => p.origin === 'stripe');
  const rows = input.payments.filter((p) => inRange(p.on, range));
  const succeeded = rows.filter((p) => p.status === 'succeeded');
  const refundedCents = rows.reduce((s, p) => s + p.refundedCents, 0);
  const collectedCents = succeeded.reduce((s, p) => s + p.amountCents, 0) - refundedCents;
  const spendCents = computeSpend(input.spend, range);
  return {
    collectedCents,
    paymentCount: succeeded.length,
    failedCount: rows.filter((p) => p.status === 'failed').length,
    refundedCents,
    roas: !awaitingStripe && spendCents > 0 ? collectedCents / spendCents : null,
    awaitingStripe,
  };
}

// ---------------------------------------------------------------------------
// Per-source breakdown
// ---------------------------------------------------------------------------

export interface SourceBreakdown {
  source: string;
  counts: Record<FunnelStageKey, number>;
  /** enrolled ÷ applied, null when applied = 0. */
  appliedToEnrolled: number | null;
  /** consult_showed ÷ consult_booked. */
  consultShowRate: number | null;
}

export function computeSourceBreakdown(input: MetricsInput, range: Range): SourceBreakdown[] {
  const sourceOf = new Map(input.contacts.map((c) => [c.id, c.source?.trim() || 'Unknown']));
  const members = funnelMembership(input, range);
  const out = new Map<string, SourceBreakdown>();

  const bump = (source: string, key: FunnelStageKey) => {
    if (!out.has(source)) {
      out.set(source, {
        source,
        counts: { applied: 0, consult_booked: 0, consult_showed: 0, roadmap_booked: 0, roadmap_showed: 0, enrolled: 0 },
        appliedToEnrolled: null,
        consultShowRate: null,
      });
    }
    out.get(source)!.counts[key] += 1;
  };

  for (const key of Object.keys(members) as FunnelStageKey[]) {
    for (const id of members[key]) bump(sourceOf.get(id) ?? 'Unknown', key);
  }

  return Array.from(out.values())
    .map((s) => ({
      ...s,
      appliedToEnrolled: s.counts.applied > 0 ? s.counts.enrolled / s.counts.applied : null,
      consultShowRate: s.counts.consult_booked > 0 ? s.counts.consult_showed / s.counts.consult_booked : null,
    }))
    .sort((a, b) => b.counts.applied - a.counts.applied || a.source.localeCompare(b.source));
}

// ---------------------------------------------------------------------------
// Time in stage
// ---------------------------------------------------------------------------

export interface TimeInStage {
  role: SemanticRole;
  samples: number;
  medianHours: number | null;
  meanHours: number | null;
}

/**
 * For each role, how long contacts spent in it before moving on. Uses every
 * transition OUT of the role that happened in range, paired with the most
 * recent prior transition INTO it for the same contact (any date).
 */
export function computeTimeInStage(input: MetricsInput, range: Range): TimeInStage[] {
  const byContact = new Map<string, TransitionRow[]>();
  for (const t of input.transitions) {
    if (!byContact.has(t.contactId)) byContact.set(t.contactId, []);
    byContact.get(t.contactId)!.push(t);
  }

  const durations = new Map<SemanticRole, number[]>();
  for (const list of byContact.values()) {
    const sorted = [...list].sort((a, b) => a.atMs - b.atMs);
    for (let i = 1; i < sorted.length; i += 1) {
      const out = sorted[i];
      const prev = sorted[i - 1];
      if (!inRange(out.on, range) || !out.fromRole || prev.toRole !== out.fromRole) continue;
      const hours = (out.atMs - prev.atMs) / 3_600_000;
      if (!durations.has(out.fromRole)) durations.set(out.fromRole, []);
      durations.get(out.fromRole)!.push(hours);
    }
  }

  return Array.from(durations.entries())
    .map(([role, hrs]) => {
      const sorted = [...hrs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return {
        role,
        samples: hrs.length,
        medianHours: round1(median),
        meanHours: round1(hrs.reduce((s, h) => s + h, 0) / hrs.length),
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export interface Delta {
  current: number | null;
  previous: number | null;
  /** current − previous, null when either side is null. */
  abs: number | null;
  /** (current − previous) ÷ |previous|, null when previous is 0/null. */
  pct: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
  /** Whether this direction is good news. Cost metrics invert. */
  good: boolean | null;
}

export function computeDelta(current: number | null, previous: number | null, lowerIsBetter = false): Delta {
  if (current === null || previous === null) {
    return { current, previous, abs: null, pct: null, direction: 'none', good: null };
  }
  const abs = current - previous;
  const pct = previous !== 0 ? abs / Math.abs(previous) : null;
  const direction = abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat';
  const good = direction === 'flat' ? null : lowerIsBetter ? direction === 'down' : direction === 'up';
  return { current, previous, abs, pct, direction, good };
}

/** Colour a stage→stage conversion against a trailing baseline. */
export type ChipTone = 'good' | 'ok' | 'warn' | 'neutral';

export function conversionTone(current: number | null, baseline: number | null): ChipTone {
  if (current === null || baseline === null || baseline === 0) return 'neutral';
  const ratio = current / baseline;
  if (ratio >= 1) return 'good';
  if (ratio >= 0.9) return 'ok';
  return 'warn';
}

// ---------------------------------------------------------------------------
// Trend series
// ---------------------------------------------------------------------------

export interface TrendPoint {
  start: string;
  end: string;
  label: string;
  applied: number;
  consultsBooked: number;
  enrolled: number;
  spendCents: number;
  cacCents: number | null;
  revenueCents: number;
}

export function computeTrend(
  input: MetricsInput,
  buckets: Array<{ start: string; end: string; label: string }>,
): TrendPoint[] {
  return buckets.map((b) => {
    const m = funnelMembership(input, b);
    const spendCents = computeSpend(input.spend, b);
    const enrolled = m.enrolled.length;
    return {
      start: b.start,
      end: b.end,
      label: b.label,
      applied: m.applied.length,
      consultsBooked: m.consult_booked.length,
      enrolled,
      spendCents,
      cacCents: enrolled > 0 && spendCents > 0 ? Math.round(spendCents / enrolled) : null,
      revenueCents: computeRevenue(input, b).collectedCents,
    };
  });
}

// ---------------------------------------------------------------------------
// Daily to-do buckets (Day-1 / Day-3)
// ---------------------------------------------------------------------------

export type TodoKind = 'applied_no_booking' | 'consult_noshow' | 'roadmap_noshow';

export interface TodoPerson {
  contactId: string;
  name: string;
  email: string | null;
  source: string | null;
  /** The date that triggered this bucket (applied on / appointment on). */
  on: string;
}

export interface TodoBuckets {
  today: string;
  day1: Record<TodoKind, TodoPerson[]>;
  day3: Record<TodoKind, TodoPerson[]>;
  total: number;
}

export const TODO_LABELS: Record<TodoKind, string> = {
  applied_no_booking: 'Applied, no consult booked',
  consult_noshow: 'Consult no-show',
  roadmap_noshow: 'Roadmap no-show',
};

function dayShift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Who needs a call today?
 *   applied_no_booking — applied exactly N days ago, still in the applied
 *                        role, and no Consult appointment ever booked.
 *   consult_noshow     — a Consult no-show exactly N days ago with no later
 *                        Consult appointment on the books.
 *   roadmap_noshow     — same for Roadmap.
 * N = 1 (Day-1) and N = 3 (Day-3). Names are listed plainly.
 */
export function computeTodoBuckets(input: MetricsInput, today: string): TodoBuckets {
  const contactById = new Map(input.contacts.map((c) => [c.id, c]));
  const apptsByContact = new Map<string, AppointmentRow[]>();
  for (const a of input.appointments) {
    if (!a.contactId) continue;
    if (!apptsByContact.has(a.contactId)) apptsByContact.set(a.contactId, []);
    apptsByContact.get(a.contactId)!.push(a);
  }

  const person = (c: ContactRow, on: string): TodoPerson => ({
    contactId: c.id,
    name: c.name,
    email: c.email,
    source: c.source,
    on,
  });

  const bucketFor = (n: number): Record<TodoKind, TodoPerson[]> => {
    const target = dayShift(today, -n);
    const out: Record<TodoKind, TodoPerson[]> = { applied_no_booking: [], consult_noshow: [], roadmap_noshow: [] };

    for (const c of input.contacts) {
      if (c.appliedOn !== target || c.role !== 'applied') continue;
      const hasConsult = (apptsByContact.get(c.id) ?? []).some((a) => a.type === 'Consult');
      if (!hasConsult) out.applied_no_booking.push(person(c, target));
    }

    for (const [contactId, appts] of apptsByContact) {
      const c = contactById.get(contactId);
      if (!c) continue;
      for (const type of ['Consult', 'Roadmap'] as const) {
        const noShow = appts.find((a) => a.type === type && a.outcome === 'no_show' && a.on === target);
        if (!noShow) continue;
        const rebooked = appts.some((a) => a.type === type && a.on > target);
        if (!rebooked) out[type === 'Consult' ? 'consult_noshow' : 'roadmap_noshow'].push(person(c, target));
      }
    }

    for (const k of Object.keys(out) as TodoKind[]) out[k].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  };

  const day1 = bucketFor(1);
  const day3 = bucketFor(3);
  const total = [...Object.values(day1), ...Object.values(day3)].reduce((s, l) => s + l.length, 0);
  return { today, day1, day3, total };
}

// ---------------------------------------------------------------------------
// Scorecard (the Monday / monthly email + KPI tiles)
// ---------------------------------------------------------------------------

export interface Scorecard {
  range: Range;
  comparisonRange: Range | null;
  funnel: Funnel;
  previousFunnel: Funnel | null;
  cac: Cac;
  revenue: Revenue;
  showRates: ShowRate[];
  kpis: {
    revenueCents: Delta;
    enrollments: Delta;
    cacCents: Delta;
    roas: Delta;
    consultsBooked: Delta;
    applied: Delta;
  };
  /** Stage→stage conversion deltas vs the comparison period. */
  conversions: Array<{ from: FunnelStageKey; to: FunnelStageKey; current: number | null; previous: number | null; tone: ChipTone }>;
  sources: SourceBreakdown[];
  timeInStage: TimeInStage[];
  /** True when every count in the funnel is zero — digests skip sending. */
  empty: boolean;
}

export function computeScorecard(
  input: MetricsInput,
  range: Range,
  comparisonRange: Range | null,
  baselineRange: Range | null,
): Scorecard {
  const funnel = computeFunnel(input, range);
  const previousFunnel = comparisonRange ? computeFunnel(input, comparisonRange) : null;
  const baselineFunnel = baselineRange ? computeFunnel(input, baselineRange) : null;
  const cac = computeCac(input, range);
  const prevCac = comparisonRange ? computeCac(input, comparisonRange) : null;
  const revenue = computeRevenue(input, range);
  const prevRevenue = comparisonRange ? computeRevenue(input, comparisonRange) : null;

  const count = (f: Funnel | null, key: FunnelStageKey) => (f ? f.stages.find((s) => s.key === key)!.count : null);

  const conversions = funnel.stages.slice(1).map((s, i) => {
    const from = funnel.stages[i].key;
    const prev = previousFunnel?.stages[i + 1].conversionFromPrevious ?? null;
    const base = baselineFunnel?.stages[i + 1].conversionFromPrevious ?? prev;
    return { from, to: s.key, current: s.conversionFromPrevious, previous: prev, tone: conversionTone(s.conversionFromPrevious, base) };
  });

  return {
    range,
    comparisonRange,
    funnel,
    previousFunnel,
    cac,
    revenue,
    showRates: computeShowRates(input, range),
    kpis: {
      revenueCents: computeDelta(revenue.awaitingStripe ? null : revenue.collectedCents, prevRevenue && !prevRevenue.awaitingStripe ? prevRevenue.collectedCents : null),
      enrollments: computeDelta(count(funnel, 'enrolled'), count(previousFunnel, 'enrolled')),
      cacCents: computeDelta(cac.cacCents, prevCac?.cacCents ?? null, true),
      roas: computeDelta(revenue.roas, prevRevenue?.roas ?? null),
      consultsBooked: computeDelta(count(funnel, 'consult_booked'), count(previousFunnel, 'consult_booked')),
      applied: computeDelta(count(funnel, 'applied'), count(previousFunnel, 'applied')),
    },
    conversions,
    sources: computeSourceBreakdown(input, range),
    timeInStage: computeTimeInStage(input, range),
    empty: funnel.stages.every((s) => s.count === 0),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by UI + emails (so they never disagree)
// ---------------------------------------------------------------------------

export function formatCents(cents: number | null, opts: { compact?: boolean } = {}): string {
  if (cents === null) return '—';
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 10_000) return `$${(dollars / 1000).toFixed(1)}k`;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dollars % 1 === 0 ? 0 : 2 });
}

export function formatPct(ratio: number | null, digits = 0): string {
  if (ratio === null) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatDelta(delta: Delta, kind: 'count' | 'cents' | 'pct' | 'ratio' = 'count'): string {
  if (delta.abs === null) return '—';
  const sign = delta.abs > 0 ? '+' : delta.abs < 0 ? '−' : '';
  const a = Math.abs(delta.abs);
  const value =
    kind === 'cents' ? formatCents(a) : kind === 'pct' ? `${(a * 100).toFixed(0)} pts` : kind === 'ratio' ? a.toFixed(2) : String(a);
  const pct = delta.pct !== null ? ` (${sign}${Math.abs(delta.pct * 100).toFixed(0)}%)` : '';
  return `${sign}${value}${pct}`;
}
