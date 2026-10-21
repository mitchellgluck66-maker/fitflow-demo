/**
 * Companion stage 3 — the MONTHLY report for the month just ended: the scorecard vs the previous month (the
 * assembly), the 3-month average from ONE loader window with computeScorecard / computeAdsKpis / computeShowRates
 * per month (pure), the onboarding month, best and worst week (trendWeekly by new-client cash, enrollments as the
 * tie-break), needs attention. Nothing is recomputed in the template.
 */

import { getScorecard } from '../metrics/service';
import { loadMetricsInput } from '../metrics/load';
import { getNarrative } from '../anthropic/narrative';
import { assembleScorecard, type ScorecardStat } from '../scorecard/assemble';
import { computeScorecard, computeAdsKpis, computeShowRates, formatCents, formatPct, type Currency } from '../metrics';
import { addMonths, monthEnd, monthStart, periodTitle, formatRangeLabel } from '../dates';

/** "September 2026" for a month's first day. */
export const monthLabel = (start: string) => new Date(`${start}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
import { getOnboardingView, type OnboardingDeps } from '../onboarding/service';
import { dataHealth } from './health';
import { reportPagePath } from './kinds';
import { reportSubject, type ReportCard, type ReportModel, type ReportSection } from './model';
import { attentionLines, onboardingCards, pct } from './shared';

export interface MonthlyDeps {
  onboarding?: OnboardingDeps;
  health?: () => Promise<{ line: string }>;
}

const card = (st: ScorecardStat): ReportCard => ({ label: st.maturing ? `${st.label} †` : st.label, value: st.value, sub: st.partial ? `${st.sub} · ${st.partial.note}` : st.sub, tone: st.tone });

export interface MonthFigures {
  applied: number;
  consults: number;
  roadmaps: number;
  enrolled: number;
  initialCents: number | null;
  collectedCents: number | null;
  spendCents: number;
  blendedCacCents: number | null;
  consultShowRate: number | null;
  roadmapShowRate: number | null;
}

/** Pure: the figures of one month from the loaded input (the same engine functions the page uses). */
export function monthFigures(input: Parameters<typeof computeScorecard>[0], m: { start: string; end: string }): MonthFigures {
  const sc = computeScorecard(input, m, null, null);
  const ads = computeAdsKpis(input, m);
  const rates = computeShowRates(input, m);
  const count = (key: string) => sc.funnel.stages.find((s) => s.key === key)?.count ?? 0;
  return {
    applied: count('applied'),
    consults: count('consult_booked'),
    roadmaps: count('roadmap_booked'),
    enrolled: count('enrolled'),
    initialCents: sc.revenue.awaitingStripe ? null : sc.revenue.initialCents,
    collectedCents: sc.revenue.awaitingStripe ? null : sc.revenue.collectedCents,
    spendCents: ads.spendCents,
    blendedCacCents: ads.blendedCacCents,
    consultShowRate: rates.find((r) => r.type === 'Consult')?.rate ?? null,
    roadmapShowRate: rates.find((r) => r.type === 'Roadmap')?.rate ?? null,
  };
}

/** Pure: the mean of the months that have the figure (null when none has it). */
export function averageFigures(months: MonthFigures[]): MonthFigures {
  const avg = (f: (m: MonthFigures) => number | null): number | null => {
    const vals = months.map(f).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const n = (f: (m: MonthFigures) => number) => Math.round((avg(f) ?? 0) * 10) / 10;
  return {
    applied: n((m) => m.applied),
    consults: n((m) => m.consults),
    roadmaps: n((m) => m.roadmaps),
    enrolled: n((m) => m.enrolled),
    initialCents: avg((m) => m.initialCents) === null ? null : Math.round(avg((m) => m.initialCents)!),
    collectedCents: avg((m) => m.collectedCents) === null ? null : Math.round(avg((m) => m.collectedCents)!),
    spendCents: Math.round(avg((m) => m.spendCents) ?? 0),
    blendedCacCents: avg((m) => m.blendedCacCents) === null ? null : Math.round(avg((m) => m.blendedCacCents)!),
    consultShowRate: avg((m) => m.consultShowRate),
    roadmapShowRate: avg((m) => m.roadmapShowRate),
  };
}

export async function buildMonthlyReport(p: { start: string; now?: Date; timezone?: string }, deps: MonthlyDeps = {}): Promise<ReportModel> {
  const now = p.now ?? new Date();
  const result = await getScorecard({ range: 'month', start: p.start, compare: 'previous_period' });
  const r = result.range;
  const narrative = await getNarrative('monthly', r.start, r.end);
  const view = assembleScorecard(result, narrative);
  const ccy: Currency = view.currency;

  // The three prior months, from one window, each through the same pure functions.
  const priorMonths = [3, 2, 1].map((i) => ({ start: addMonths(monthStart(r.start), -i), end: monthEnd(addMonths(monthStart(r.start), -i)) }));
  const input = await loadMetricsInput({ start: priorMonths[0].start, end: r.end, timezone: result.timezone });
  const thisMonth = monthFigures(input, r);
  const lastMonth = monthFigures(input, priorMonths[2]);
  const avg3 = averageFigures(priorMonths.map((m) => monthFigures(input, m)));

  const [onboarding, health] = await Promise.all([getOnboardingView({ range: 'month', date: r.start, now, timezone: p.timezone }, deps.onboarding), (deps.health ?? dataHealth)(now)]);
  if ('error' in onboarding) throw new Error(onboarding.detail);
  const n = onboarding.numbers;

  const money = (c: number | null) => (c === null ? 'awaiting Stripe' : formatCents(c, ccy));
  const cmpRows: string[][] = [
    ['Applied', String(thisMonth.applied), String(lastMonth.applied), String(avg3.applied)],
    ['Consults booked', String(thisMonth.consults), String(lastMonth.consults), String(avg3.consults)],
    ['Roadmaps booked', String(thisMonth.roadmaps), String(lastMonth.roadmaps), String(avg3.roadmaps)],
    ['Enrolled (GHL)', String(thisMonth.enrolled), String(lastMonth.enrolled), String(avg3.enrolled)],
    ['New-client cash', money(thisMonth.initialCents), money(lastMonth.initialCents), money(avg3.initialCents)],
    ['Cash collected', money(thisMonth.collectedCents), money(lastMonth.collectedCents), money(avg3.collectedCents)],
    ['Ad spend', formatCents(thisMonth.spendCents, ccy), formatCents(lastMonth.spendCents, ccy), formatCents(avg3.spendCents, ccy)],
    ['Blended CAC', thisMonth.blendedCacCents === null ? '—' : formatCents(thisMonth.blendedCacCents, ccy), lastMonth.blendedCacCents === null ? '—' : formatCents(lastMonth.blendedCacCents, ccy), avg3.blendedCacCents === null ? '—' : formatCents(avg3.blendedCacCents, ccy)],
    ['Consult show rate', formatPct(thisMonth.consultShowRate), formatPct(lastMonth.consultShowRate), formatPct(avg3.consultShowRate)],
    ['Roadmap show rate', formatPct(thisMonth.roadmapShowRate), formatPct(lastMonth.roadmapShowRate), formatPct(avg3.roadmapShowRate)],
  ];

  // Best and worst week by new-client cash (enrollments break a tie) — the engine's weekly trend.
  const weeks = result.trendWeekly.current;
  const ranked = [...weeks].sort((a, b) => b.initialCents - a.initialCents || b.enrolled - a.enrolled);
  const weekLine = (w: (typeof weeks)[number]) => `${w.label}: ${formatCents(w.initialCents, w.currency)} new-client cash · ${w.enrolled} enrolled · ${w.applied} applied · ${formatCents(w.spendCents, w.currency)} spend`;
  const bestWorst = ranked.length ? [`Best week — ${weekLine(ranked[0])}`, ...(ranked.length > 1 ? [`Worst week — ${weekLine(ranked[ranked.length - 1])}`] : [])] : [];

  // A month lists its unlogged calls as ONE count (the Onboarding page has them one by one) and every failed log.
  const attention = attentionLines(onboarding.attention.filter((a) => a.kind === 'failed_log'), 15);
  if (n.unlogged) attention.unshift(`${n.unlogged} ended call${n.unlogged === 1 ? '' : 's'} with no outcome logged this month — see the Onboarding page.`);
  for (const note of view.notes) if (note.tone === 'warn') attention.push(note.text);

  const sections: ReportSection[] = [
    ...(view.narrative ? [{ type: 'text' as const, title: view.narrativeTitle, text: view.narrative }] : []),
    { type: 'table', title: 'This month vs last month and the 3-month average', hint: `avg of ${priorMonths.map((m) => monthLabel(m.start)).join(', ')}`, headers: ['Metric', periodTitle(r), 'Last month', '3-month avg'], rows: cmpRows, align: ['left', 'right', 'right', 'right'] },
    { type: 'stats', title: 'Money', hint: view.subtitle ?? undefined, cards: view.sections.money.map(card) },
    { type: 'stats', title: 'Pipeline', cards: view.sections.pipeline.map(card) },
    { type: 'stats', title: 'Ads', cards: view.sections.ads.map(card) },
    { type: 'lines', title: 'Best and worst week', hint: 'by new-client cash', lines: bestWorst },
    { type: 'table', title: 'Funnel and cost per stage', hint: view.period.label, headers: ['Stage', 'Count', 'Of applied', 'From previous', 'Cost per'], rows: view.funnelRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'stats', title: 'Onboarding month', hint: onboarding.users.length ? `${onboarding.users.map((u) => u.name).join(', ')} · show rate ${pct(n.showedPct)} of logged · ${n.unlogged} unlogged` : undefined, cards: onboardingCards(n) },
    { type: 'text', title: 'Customer acquisition cost', text: view.cacLine },
    { type: 'table', title: 'Show rates', headers: ['Type', 'Showed', 'No-show', 'Cancelled', 'Show rate'], rows: view.showRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'table', title: 'Top sources', headers: ['Source', 'Applied', 'Consults', 'Enrolled', 'Applied → client'], rows: view.sourceRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'lines', title: 'Notes', lines: view.notes.filter((x) => x.tone === 'info').map((x) => x.text) },
  ];
  if (onboarding.reason) sections.push({ type: 'text', title: 'Onboarding', text: onboarding.reason, tone: 'warn' });

  const clients = result.scorecard.revenue.awaitingStripe ? null : result.scorecard.revenue.initialCount;
  const headlineText = clients === null
    ? `${result.scorecard.kpis.enrollments.current ?? 0} enrolled, ${result.scorecard.kpis.applied.current ?? 0} applied (awaiting Stripe)`
    : `${clients} new client${clients === 1 ? '' : 's'}, ${formatCents(result.scorecard.revenue.initialCents, ccy)} vs ${avg3.initialCents === null ? 'no 3-month average' : `${formatCents(avg3.initialCents, ccy)} avg`}`;
  const label = periodTitle(r);
  return {
    kind: 'monthly',
    period: { start: r.start, end: r.end, label },
    subject: reportSubject('monthly', label, headlineText),
    headline: `${headlineText}. ${n.calls} onboarding call${n.calls === 1 ? '' : 's'}, ${n.enrolled} enrolled on a call, ${n.logged ? `${pct(n.showedPct)} showed of ${n.logged} logged` : 'none logged'}.`,
    totals: [view.sections.money[0], view.sections.money[1], view.sections.pipeline[0], view.sections.ads[0]].map(card),
    attention,
    sections,
    health: health.line,
    button: { label: 'Open the Scorecard', path: reportPagePath('monthly', r) },
    footer: `The month just ended${view.subtitle ? `, ${view.subtitle}` : ''}; the 3-month average covers ${formatRangeLabel(priorMonths[0].start, priorMonths[2].end)}. ${view.fxNote}.${result.maturity.active ? ' † = maturing data (see Needs attention).' : ''} Read-only — nothing in this email changes the pipeline.`,
    empty: view.empty && n.calls === 0,
  };
}
