/**
 * Companion stage 3 — the WEEKLY report for the Sun–Sat week just ended: the scorecard's Money / Pipeline / Ads
 * (lib/scorecard/assemble — the same model the /scorecard page renders), the computed week verdict (the SAME
 * function the Analyst cites), cost per stage, spend changes allowed / blocked by the existing gates, the
 * onboarding week, the top 3 changes vs last week (the three assembled stats with the largest relative delta —
 * no new math), needs attention. Nothing is recomputed here.
 */

import { getScorecard, type ScorecardResult } from '../metrics/service';
import { getNarrative } from '../anthropic/narrative';
import { assembleScorecard, type ScorecardStat } from '../scorecard/assemble';
import { formatCents } from '../metrics';
import { formatRangeLabel } from '../dates';
import { getOnboardingView, type OnboardingDeps, type OnboardingView } from '../onboarding/service';
import { onboardingNumbers } from '../onboarding/numbers';
import { dataHealth } from './health';
import { reportPagePath } from './kinds';
import { reportSubject, type ReportCard, type ReportModel, type ReportSection } from './model';
import { attentionLines, onboardingCards, pct } from './shared';

export interface WeeklyDeps {
  onboarding?: OnboardingDeps;
  health?: () => Promise<{ line: string }>;
}

const card = (st: ScorecardStat): ReportCard => ({ label: st.maturing ? `${st.label} †` : st.label, value: st.value, sub: st.partial ? `${st.sub} · ${st.partial.note}` : st.sub, tone: st.tone });

/** The three stats that moved most (by |relative delta|), as "Enrollments 4 → 7 (+75%)". */
export function topChanges(stats: ScorecardStat[], n = 3): string[] {
  return stats
    .filter((s) => s.delta.pct !== null && s.delta.abs !== null && s.delta.abs !== 0 && !s.empty)
    .sort((a, b) => Math.abs(b.delta.pct!) - Math.abs(a.delta.pct!))
    .slice(0, n)
    .map((s) => `${s.label}: ${s.value} (${s.sub})${s.tone === 'bad' ? ' — worse' : s.tone === 'good' ? ' — better' : ''}`);
}

export interface WeeklyModelInput {
  result: ScorecardResult;
  narrative: string | null;
  /** The onboarding week; null = the section is left out (pure tests). */
  onboarding: OnboardingView | null;
  health: string | null;
}

/** PURE: the weekly model from an engine result (+ the onboarding week) — what the tests exercise without a database. */
export function weeklyModel({ result, narrative, onboarding, health }: WeeklyModelInput): ReportModel {
  const r = result.range;
  const view = assembleScorecard(result, narrative);
  const ccy = view.currency;
  const v = result.verdict;
  const k = result.scorecard.kpis;
  const n = onboarding?.numbers ?? onboardingNumbers([]);

  const verdictLine = v.verdict === 'unavailable' ? `Verdict not available — ${v.reason}.` : `${v.verdict.charAt(0).toUpperCase()}${v.verdict.slice(1)} week — ${v.basisClients}; ${v.basisCash}.`;
  const gates = result.spendGates;
  const gateLines = [gates.account, ...gates.campaigns].map((g) => `${g.campaign === 'account' ? 'Whole account' : g.campaign}: ${g.decision === 'may_change' ? 'may change' : 'HOLD'} — ${g.basis}`);
  const campaignLine = view.campaigns.top
    ? `Best cost per client: ${view.campaigns.top.campaignName} (${formatCents(view.campaigns.top.costPerEnrollmentCents, ccy)}/client, ${view.campaigns.top.enrolled} enrolled from ${formatCents(view.campaigns.top.spendCents, ccy)}).` +
      (view.campaigns.worst ? ` Worst: ${view.campaigns.worst.campaignName} (${formatCents(view.campaigns.worst.costPerEnrollmentCents, ccy)}/client, ${view.campaigns.worst.enrolled} enrolled from ${formatCents(view.campaigns.worst.spendCents, ccy)}).` : '') +
      (view.campaigns.note ? ` ${view.campaigns.note}` : '')
    : view.campaigns.note;

  const attention = onboarding ? attentionLines(onboarding.attention) : [];
  if (n.unlogged) attention.unshift(`${n.unlogged} ended call${n.unlogged === 1 ? '' : 's'} with no outcome logged this week.`);
  for (const note of view.notes) if (note.tone === 'warn') attention.push(note.text);

  const sections: ReportSection[] = [
    { type: 'text', title: 'Week verdict', text: `${verdictLine} Rule: ${v.rule}. Baseline: ${v.baselineSummary}.`, tone: v.verdict === 'weak' ? 'warn' : 'info' },
    ...(view.narrative ? [{ type: 'text' as const, title: view.narrativeTitle, text: view.narrative }] : []),
    { type: 'lines', title: 'Top 3 changes vs last week', hint: view.subtitle ?? undefined, lines: topChanges([...view.sections.money, ...view.sections.pipeline, ...view.sections.ads]) },
    { type: 'stats', title: 'Money', hint: view.subtitle ?? undefined, cards: view.sections.money.map(card) },
    { type: 'stats', title: 'Pipeline', cards: view.sections.pipeline.map(card) },
    { type: 'stats', title: 'Ads', cards: view.sections.ads.map(card) },
    { type: 'text', title: 'Campaigns', text: campaignLine },
    { type: 'table', title: 'Funnel and cost per stage', hint: view.period.label, headers: ['Stage', 'Count', 'Of applied', 'From previous', 'Cost per'], rows: view.funnelRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'lines', title: 'Spend changes allowed / blocked', hint: gates.window.note ?? (gates.window.start ? `window ${formatRangeLabel(gates.window.start, gates.window.end ?? gates.window.start)} · ${gates.window.weeksUsed} weeks` : undefined), lines: gateLines },
    ...(onboarding
      ? [
          { type: 'stats' as const, title: 'Onboarding week', hint: onboarding.users.length ? `${onboarding.users.map((u) => u.name).join(', ')} · show rate ${pct(n.showedPct)} of logged · ${n.unlogged} unlogged` : undefined, cards: onboardingCards(n) },
          ...(onboarding.reason ? [{ type: 'text' as const, title: 'Onboarding', text: onboarding.reason, tone: 'warn' as const }] : []),
        ]
      : []),
    { type: 'text', title: 'Customer acquisition cost', text: view.cacLine },
    { type: 'table', title: 'Show rates', headers: ['Type', 'Showed', 'No-show', 'Cancelled', 'Show rate'], rows: view.showRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'table', title: 'Top sources', headers: ['Source', 'Applied', 'Consults', 'Enrolled', 'Applied → client'], rows: view.sourceRows, align: ['left', 'right', 'right', 'right', 'right'] },
    { type: 'lines', title: 'Notes', lines: view.notes.filter((x) => x.tone === 'info').map((x) => x.text) },
  ];

  const clients = v.clients ?? (result.scorecard.revenue.awaitingStripe ? null : result.scorecard.revenue.initialCount);
  const headlineText = result.scorecard.revenue.awaitingStripe
    ? `${k.enrollments.current ?? 0} enrolled, ${k.consultsBooked.current ?? 0} consults booked (awaiting Stripe)`
    : `${v.verdict === 'unavailable' ? '' : `${v.verdict} week: `}${clients ?? 0} new client${clients === 1 ? '' : 's'}, ${formatCents(result.scorecard.revenue.initialCents, ccy)}`;
  const label = formatRangeLabel(r.start, r.end);
  return {
    kind: 'weekly',
    period: { start: r.start, end: r.end, label },
    subject: reportSubject('weekly', label, headlineText),
    headline: `${headlineText.charAt(0).toUpperCase()}${headlineText.slice(1)}.${onboarding ? ` ${n.calls} onboarding call${n.calls === 1 ? '' : 's'}, ${n.enrolled} enrolled on a call, ${n.noShows} no-show${n.noShows === 1 ? '' : 's'}.` : ''}`,
    totals: [view.sections.money[0], view.sections.money[1], view.sections.pipeline[0], view.sections.ads[0]].map(card),
    attention,
    sections,
    health,
    button: { label: 'Open the Scorecard', path: reportPagePath('weekly', r) },
    footer: `The Sun–Sat week just ended${view.subtitle ? `, ${view.subtitle}` : ''}. ${view.fxNote}.${result.maturity.active ? ' † = maturing data (see Needs attention).' : ''} Read-only — nothing in this email changes the pipeline.`,
    empty: view.empty && n.calls === 0,
  };
}

export async function buildWeeklyReport(p: { start: string; now?: Date; timezone?: string }, deps: WeeklyDeps = {}): Promise<ReportModel> {
  const now = p.now ?? new Date();
  const result = await getScorecard({ range: 'week', start: p.start, compare: 'previous_period' });
  const r = result.range;
  const [narrative, onboarding, health] = await Promise.all([getNarrative('weekly', r.start, r.end), getOnboardingView({ range: 'week', date: r.start, now, timezone: p.timezone }, deps.onboarding), (deps.health ?? dataHealth)(now)]);
  if ('error' in onboarding) throw new Error(onboarding.detail);
  return weeklyModel({ result, narrative, onboarding, health: health.line });
}
