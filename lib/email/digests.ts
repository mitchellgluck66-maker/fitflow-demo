/**
 * The three digests. Every number comes from lib/metrics via
 * lib/metrics/service — the same call path the Command Center uses.
 *
 * Scorecard rules: one timeframe per digest; `empty` tells the sender to
 * skip rather than mail a page of zeros.
 */

import { getScorecard, getTodoBuckets } from '../metrics/service';
import { FUNNEL_STAGES, TODO_LABELS, formatCents, formatPct, formatDelta, type Delta, type TodoKind } from '../metrics';
import { formatLongDate, formatRangeLabel } from '../dates';
import { shell, sectionTitle, note, statRow, table, peopleList, textHeader, textTable } from './templates';

export type DigestKind = 'daily_todo' | 'weekly' | 'monthly';

export interface Digest {
  kind: DigestKind;
  periodStart: string;
  periodEnd: string;
  subject: string;
  html: string;
  text: string;
  empty: boolean;
}

export const DIGEST_LABELS: Record<DigestKind, string> = {
  daily_todo: 'Daily to-do',
  weekly: 'Weekly scorecard',
  monthly: 'Monthly scorecard',
};

// ---------------------------------------------------------------------------
// Daily to-do
// ---------------------------------------------------------------------------

const TODO_ORDER: TodoKind[] = ['applied_no_booking', 'consult_noshow', 'roadmap_noshow'];

export async function buildDailyTodo(today?: string): Promise<Digest> {
  const { today: day, buckets } = await getTodoBuckets(today);
  const title = formatLongDate(day);

  const section = (label: string, bucket: typeof buckets.day1) => {
    const count = TODO_ORDER.reduce((s, k) => s + bucket[k].length, 0);
    return (
      sectionTitle(label, `${count} ${count === 1 ? 'person' : 'people'}`) +
      TODO_ORDER.map(
        (k) =>
          `<div style="font-size:12.5px;font-weight:600;color:#55585e;margin-top:8px;">${TODO_LABELS[k]} (${bucket[k].length})</div>` +
          peopleList(bucket[k]),
      ).join('')
    );
  };

  const bodyHtml =
    (buckets.total === 0 ? note('Nothing needs a call today.') : '') +
    section('Day-1 follow-ups', buckets.day1) +
    section('Day-3 follow-ups', buckets.day3);

  const textLines = textHeader('Daily to-do', title);
  for (const [label, bucket] of [
    ['DAY-1 FOLLOW-UPS', buckets.day1],
    ['DAY-3 FOLLOW-UPS', buckets.day3],
  ] as const) {
    textLines.push(label, '-'.repeat(40));
    for (const k of TODO_ORDER) {
      textLines.push(`${TODO_LABELS[k]} (${bucket[k].length})`);
      for (const p of bucket[k]) textLines.push(`  - ${p.name} — ${p.email ?? 'no email'} — ${p.source ?? 'source unknown'} — ${p.on}`);
    }
    textLines.push('');
  }

  return {
    kind: 'daily_todo',
    periodStart: day,
    periodEnd: day,
    subject: `FitFlow to-do — ${title} (${buckets.total} to call)`,
    html: shell({
      kicker: 'Daily to-do',
      title,
      subtitle: 'Day-1 and Day-3 follow-ups',
      bodyHtml,
      footerNote: 'Day-1 = happened yesterday. Day-3 = three days ago and still not moved. Read-only mirror of GoHighLevel.',
    }),
    text: textLines.join('\n'),
    empty: buckets.total === 0,
  };
}

// ---------------------------------------------------------------------------
// Weekly / monthly scorecard (same template, different grain)
// ---------------------------------------------------------------------------

function deltaSub(d: Delta, kind: 'count' | 'cents' | 'pct' | 'ratio' = 'count'): { sub: string; tone: 'good' | 'bad' | 'neutral' } {
  if (d.abs === null) return { sub: 'no comparison', tone: 'neutral' };
  return { sub: formatDelta(d, kind), tone: d.good === null ? 'neutral' : d.good ? 'good' : 'bad' };
}

async function buildScorecard(kind: 'weekly' | 'monthly', today?: string): Promise<Digest> {
  const range = kind === 'weekly' ? 'last_week' : 'last_month';
  // NOTE: getScorecard resolves 'today' from the business timezone itself;
  // the `today` override only applies to the daily to-do (tests).
  void today;
  const result = await getScorecard({ range, compare: 'previous_period' });
  const { scorecard, comparison } = result;
  const r = result.range;
  const title = kind === 'weekly' ? `Week of ${r.resolvedLabel}` : r.resolvedLabel;
  const subtitle = comparison.range ? `vs ${comparison.range.resolvedLabel}` : null;

  const k = scorecard.kpis;
  const awaiting = scorecard.revenue.awaitingStripe;
  const cards = [
    awaiting
      ? { label: 'Revenue collected', value: '—', sub: 'Awaiting Stripe', tone: 'neutral' as const }
      : { label: 'Revenue collected', value: formatCents(k.revenueCents.current), ...deltaSub(k.revenueCents, 'cents') },
    { label: 'Enrollments', value: String(k.enrollments.current ?? 0), ...deltaSub(k.enrollments) },
    {
      label: 'Cost per client',
      value: k.cacCents.current === null ? '—' : formatCents(k.cacCents.current),
      ...(k.cacCents.current === null
        ? { sub: scorecard.cac.noSpendData ? 'no spend entered' : 'no enrollments', tone: 'neutral' as const }
        : deltaSub(k.cacCents, 'cents')),
    },
    awaiting
      ? { label: 'ROAS', value: '—', sub: 'Awaiting Stripe', tone: 'neutral' as const }
      : { label: 'ROAS', value: k.roas.current === null ? '—' : `${k.roas.current.toFixed(2)}×`, ...deltaSub(k.roas, 'ratio') },
    { label: 'Consults booked', value: String(k.consultsBooked.current ?? 0), ...deltaSub(k.consultsBooked) },
  ];

  const funnelRows = scorecard.funnel.stages.map((s) => [
    FUNNEL_STAGES.find((f) => f.key === s.key)?.label ?? s.key,
    String(s.count),
    formatPct(s.shareOfApplied),
    s.conversionFromPrevious === null ? '—' : formatPct(s.conversionFromPrevious),
    s.costPerCents === null ? '—' : formatCents(s.costPerCents),
  ]);
  const showRows = scorecard.showRates.map((s) => [s.type, String(s.showed), String(s.noShow), String(s.cancelled), formatPct(s.rate)]);
  const sourceRows = scorecard.sources
    .slice(0, 8)
    .map((s) => [s.source, String(s.counts.applied), String(s.counts.consult_booked), String(s.counts.enrolled), formatPct(s.appliedToEnrolled)]);

  const cacLine = scorecard.cac.cacCents
    ? `${formatCents(scorecard.cac.spendCents)} spend ÷ ${scorecard.cac.enrollments} enrollments = ${formatCents(scorecard.cac.cacCents)} per client`
    : scorecard.cac.noSpendData
      ? 'No ad spend entered for this period — add weekly spend in Setup to get cost per client.'
      : `${formatCents(scorecard.cac.spendCents)} spend, no enrollments this period.`;

  const bodyHtml =
    statRow(cards) +
    (awaiting ? note('Revenue and ROAS will appear once Stripe is connected (Phase C). Nothing here is estimated.') : '') +
    sectionTitle('Funnel', r.resolvedLabel) +
    table(['Stage', 'Count', 'Of applied', 'From previous', 'Cost per'], funnelRows, ['left', 'right', 'right', 'right', 'right']) +
    sectionTitle('Cost per client') +
    `<div style="font-size:13px;color:#55585e;">${cacLine}</div>` +
    sectionTitle('Show rates') +
    table(['Type', 'Showed', 'No-show', 'Cancelled', 'Show rate'], showRows, ['left', 'right', 'right', 'right', 'right']) +
    sectionTitle('Top sources') +
    table(['Source', 'Applied', 'Consults', 'Enrolled', 'Applied → client'], sourceRows, ['left', 'right', 'right', 'right', 'right']);

  const text = [
    ...textHeader(DIGEST_LABELS[kind], title, subtitle),
    ...cards.map((c) => `${c.label.padEnd(18)} ${c.value.padEnd(10)} ${c.sub ?? ''}`),
    '',
    'FUNNEL',
    ...textTable(['Stage', 'Count', 'Of applied', 'From prev', 'Cost per'], funnelRows),
    '',
    'COST PER CLIENT',
    cacLine,
    '',
    'SHOW RATES',
    ...textTable(['Type', 'Showed', 'No-show', 'Cancelled', 'Rate'], showRows),
    '',
    'TOP SOURCES',
    ...textTable(['Source', 'Applied', 'Consults', 'Enrolled', 'Applied→client'], sourceRows),
  ].join('\n');

  return {
    kind,
    periodStart: r.start,
    periodEnd: r.end,
    subject: `FitFlow ${kind} scorecard — ${formatRangeLabel(r.start, r.end)}: ${k.enrollments.current ?? 0} enrolled, ${k.consultsBooked.current ?? 0} consults booked`,
    html: shell({ kicker: DIGEST_LABELS[kind], title, subtitle, bodyHtml }),
    text,
    empty: scorecard.empty,
  };
}

export function buildWeeklyScorecard(today?: string): Promise<Digest> {
  return buildScorecard('weekly', today);
}

export function buildMonthlyScorecard(today?: string): Promise<Digest> {
  return buildScorecard('monthly', today);
}

export function buildDigest(kind: DigestKind, today?: string): Promise<Digest> {
  if (kind === 'daily_todo') return buildDailyTodo(today);
  if (kind === 'weekly') return buildWeeklyScorecard(today);
  return buildMonthlyScorecard(today);
}

export function isDigestKind(value: unknown): value is DigestKind {
  return value === 'daily_todo' || value === 'weekly' || value === 'monthly';
}
