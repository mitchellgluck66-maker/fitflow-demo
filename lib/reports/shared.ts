/** Companion stage 3 — pieces the three report builders share: the onboarding section, formatting of deltas. */

import { formatCents, formatPct, computeDelta, type Delta, type Currency } from '../metrics';
import { ghlResultOf, outcomeLabelOf, stageMoveOf, type OnboardingCall, type OnboardingNumbers, type AttentionItem } from '../onboarding/numbers';
import type { OnboardingView } from '../onboarding/service';
import type { ReportCard, ReportSection } from './model';

export const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);

/** "+3 vs last week" / "no change" / "no comparison". */
export function vs(d: Delta, kind: 'count' | 'cents' | 'pct' | 'ratio', currency: Currency, against: string): string {
  if (d.abs === null) return `no ${against} comparison`;
  if (d.abs === 0) return `no change vs ${against}`;
  const sign = d.abs > 0 ? '+' : '−';
  const abs = Math.abs(d.abs);
  const body = kind === 'cents' ? formatCents(abs, currency) : kind === 'pct' ? `${(abs * 100).toFixed(0)} pts` : kind === 'ratio' ? abs.toFixed(2) : String(abs);
  const rel = d.pct === null ? '' : ` (${d.pct > 0 ? '+' : ''}${Math.round(d.pct * 100)}%)`;
  return `${sign}${body}${rel} vs ${against}`;
}

export function countCard(label: string, current: number | null, previous: number | null, against: string, opts: { lowerIsBetter?: boolean; sub?: string } = {}): ReportCard {
  const d = computeDelta(current, previous, opts.lowerIsBetter);
  return { label, value: current === null ? '—' : String(current), sub: opts.sub ?? vs(d, 'count', 'CAD', against), tone: d.good === null ? 'neutral' : d.good ? 'good' : 'bad' };
}

export function centsCard(label: string, current: number | null, previous: number | null, currency: Currency, against: string, opts: { lowerIsBetter?: boolean; missing?: string; sub?: string } = {}): ReportCard {
  if (current === null) return { label, value: '—', sub: opts.missing ?? 'not available', tone: 'neutral' };
  const d = computeDelta(current, previous, opts.lowerIsBetter);
  return { label, value: formatCents(current, currency), sub: opts.sub ?? vs(d, 'cents', currency, against), tone: d.good === null ? 'neutral' : d.good ? 'good' : 'bad' };
}

/** The onboarding totals as cards (the six tiles). */
export function onboardingCards(n: OnboardingNumbers): ReportCard[] {
  return [
    { label: 'Calls', value: String(n.calls), sub: `${n.consults} consult${n.consults === 1 ? '' : 's'} · ${n.roadmaps} roadmap${n.roadmaps === 1 ? '' : 's'}` },
    { label: 'Logged', value: `${n.logged} of ${n.calls}`, sub: n.needsOutcome ? `${n.needsOutcome} need${n.needsOutcome === 1 ? 's' : ''} an outcome` : n.unlogged ? `${n.unlogged} unlogged` : undefined, tone: n.needsOutcome ? 'bad' : 'neutral' },
    { label: 'Showed', value: String(n.showed), sub: n.logged ? `of ${n.logged} logged · ${pct(n.showedPct)}` : 'nothing logged' },
    { label: 'Roadmaps booked', value: String(n.roadmapsBooked), sub: `from ${n.consults} consult${n.consults === 1 ? '' : 's'}` },
    { label: 'Enrolled', value: String(n.enrolled), sub: `from ${n.roadmaps} roadmap${n.roadmaps === 1 ? '' : 's'}`, tone: n.enrolled ? 'good' : 'neutral' },
    { label: 'No-shows', value: String(n.noShows), sub: `${n.consultNoShows} consult · ${n.roadmapNoShows} roadmap`, tone: n.noShows ? 'bad' : 'neutral' },
  ];
}

export function attentionLines(items: AttentionItem[], max = 12): string[] {
  const lines = items.map((a) => a.text);
  return lines.length > max ? [...lines.slice(0, max), `and ${lines.length - max} more — see the Onboarding page`] : lines;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every call as a table row: when · client · outcome · stage · note · GoHighLevel. */
export function callsTable(view: OnboardingView, opts: { withDate: boolean; max?: number }): ReportSection {
  const rows = view.calls.slice(0, opts.max ?? 60).map((c: OnboardingCall) => {
    const g = ghlResultOf(c);
    return [
      `${opts.withDate ? `${c.date.slice(5).replace('-', '/')} ` : ''}${c.timeLabel} · ${c.callType === 'Other' ? c.calendarName : c.callType}${view.users.length > 1 ? ` · ${c.userName}` : ''}`,
      c.name,
      outcomeLabelOf(c).label,
      stageMoveOf(c),
      clip(c.log?.note ?? '—', 140),
      g.sub && g.tone !== 'ok' ? `${g.label} · ${g.sub}` : g.label,
    ];
  });
  if (view.calls.length > rows.length) rows.push([`and ${view.calls.length - rows.length} more`, '', '', '', '', 'see the Onboarding page']);
  return { type: 'table', title: 'Every call', hint: view.calls.length ? `${view.calls.length} · ${view.users.map((u) => u.name).join(', ')}` : undefined, headers: ['When', 'Client', 'Outcome', 'Stage before → after', 'Note', 'GoHighLevel'], rows };
}

export const money = (cents: number | null, currency: Currency) => (cents === null ? '—' : formatCents(cents, currency));
export { formatPct };
