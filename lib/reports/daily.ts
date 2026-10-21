/**
 * Companion stage 3 — the DAILY report, for yesterday (00:00–23:59 business time): the day's funnel entries (GHL),
 * first payments and cash (Stripe), ad spend (Meta "still settling" inside 48 h — d7076e4), cost per applicant /
 * per enrollment, each vs the same weekday last week; the whole Onboarding section; the data-health line; then
 * the follow-ups (Day-1 / Day-3 / awaiting rebook) the retired to-do carried. Every number is the engine's.
 */

import { loadMetricsInput } from '../metrics/load';
import { getMaturity, getTodoBuckets } from '../metrics/service';
import { computeScorecard, computeAdsKpis, computeDelta, formatCents, TODO_LABELS, REBOOK_LABELS, type TodoKind, type RebookKind, type FunnelStageKey, type Funnel } from '../metrics';
import { maturingCaveatText } from '../metrics/maturity';
import { addDays, formatLongDate, dayOfWeek } from '../dates';
import { todayInTimezone } from '../day';
import { getTimezone } from '../settings';
import { metaSettling, META_SETTLING_HOURS } from '../email/schedule';
import { getOnboardingView, type OnboardingDeps } from '../onboarding/service';
import { onboardingHeadline } from '../onboarding/numbers';
import { dataHealth } from './health';
import { reportPagePath } from './kinds';
import { reportSubject, type ReportModel, type ReportSection } from './model';
import { attentionLines, callsTable, centsCard, countCard, onboardingCards, vs } from './shared';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DailyDeps {
  onboarding?: OnboardingDeps;
  /** Tests: skip the follow-ups section (it needs a timezone-resolved "today" from the DB). */
  health?: () => Promise<{ line: string }>;
}

export async function buildDailyReport(p: { date: string; now?: Date; timezone?: string }, deps: DailyDeps = {}): Promise<ReportModel> {
  const now = p.now ?? new Date();
  const timezone = p.timezone ?? (await getTimezone());
  const today = todayInTimezone(timezone, now);
  const day = { start: p.date, end: p.date };
  const lastWeek = { start: addDays(p.date, -7), end: addDays(p.date, -7) };
  const against = `last ${DOW[dayOfWeek(p.date)]}`;

  const input = await loadMetricsInput({ start: lastWeek.start, end: p.date, timezone });
  const sc = computeScorecard(input, day, lastWeek, null);
  const ads = computeAdsKpis(input, day);
  const prevAds = computeAdsKpis(input, lastWeek);
  const ccy = sc.currency;
  const rev = sc.revenue;
  const prevRev = sc.previousFunnel ? computeScorecard(input, lastWeek, null, null).revenue : null;
  const maturity = await getMaturity(day, today, [lastWeek]);
  const [onboarding, health, todo] = await Promise.all([getOnboardingView({ range: 'day', date: p.date, now, timezone }, deps.onboarding), (deps.health ?? dataHealth)(now), getTodoBuckets(today).catch(() => null)]);
  if ('error' in onboarding) throw new Error(onboarding.detail);

  const count = (f: Funnel | null, key: FunnelStageKey) => f?.stages.find((s) => s.key === key)?.count ?? null;
  const stage = (key: FunnelStageKey) => sc.funnel.stages.find((s) => s.key === key);
  const applied = count(sc.funnel, 'applied') ?? 0;
  const consults = count(sc.funnel, 'consult_booked') ?? 0;
  const showed = stage('consult_showed');
  const roadmaps = count(sc.funnel, 'roadmap_booked') ?? 0;
  const enrolled = count(sc.funnel, 'enrolled') ?? 0;
  const firstPayments = rev.awaitingStripe ? null : rev.initialCount;

  // ---- Funnel (GHL stage entries, dated by the entry) ------------------------------------------------------
  const funnelCards = [
    countCard('Applied', applied, count(sc.previousFunnel, 'applied'), against),
    countCard('Consults booked', consults, count(sc.previousFunnel, 'consult_booked'), against),
    showed?.withheld ? { label: 'Consults showed', value: '—', sub: showed.withheld, tone: 'neutral' as const } : countCard('Consults showed', showed?.count ?? 0, count(sc.previousFunnel, 'consult_showed'), against),
    countCard('Roadmaps booked', roadmaps, count(sc.previousFunnel, 'roadmap_booked'), against),
    countCard('Enrolled (GHL)', enrolled, count(sc.previousFunnel, 'enrolled'), against),
    rev.awaitingStripe ? { label: 'First payments', value: '—', sub: 'awaiting Stripe', tone: 'neutral' as const } : countCard('First payments (Stripe)', rev.initialCount, prevRev?.initialCount ?? null, against),
  ];

  // ---- Money + spend --------------------------------------------------------------------------------------
  const settling = metaSettling(p.date, timezone, now);
  const meta = ads.byPlatform.find((b) => b.platform === 'meta');
  const noSpendRows = ads.spendCents === 0 && !ads.apiConnected;
  const spendSub = noSpendRows ? `no spend rows for ${formatLongDate(p.date)}` : `${vs(computeDelta(ads.spendCents, prevAds.spendCents, true), 'cents', ccy, against)}${meta && settling ? ` · Meta still settling (restated for up to ${META_SETTLING_HOURS} h)` : ''}`;
  const moneyCards = [
    rev.awaitingStripe ? { label: 'Cash collected', value: '—', sub: 'awaiting Stripe — no payment rows', tone: 'neutral' as const } : centsCard('Cash collected', rev.collectedCents, prevRev?.collectedCents ?? null, ccy, against),
    rev.awaitingStripe ? { label: 'New-client cash', value: '—', sub: 'awaiting Stripe', tone: 'neutral' as const } : centsCard('New-client cash', rev.initialCents, prevRev?.initialCents ?? null, ccy, against),
    // A source with no rows says so — never "$0".
    { label: 'Ad spend', value: noSpendRows ? '—' : formatCents(ads.spendCents, ccy), sub: spendSub, tone: 'neutral' as const },
    centsCard('Cost per applicant', ads.costPerLeadCents, prevAds.costPerLeadCents, ccy, against, { lowerIsBetter: true, missing: ads.spendCents === 0 ? 'no spend' : 'no applicants' }),
    centsCard('Cost per enrollment', ads.blendedCacCents, prevAds.blendedCacCents, ccy, against, { lowerIsBetter: true, missing: ads.spendCents === 0 ? 'no spend' : 'no enrollments' }),
  ];

  // ---- Attention: onboarding first, then the cross-source gap --------------------------------------------
  const attention = attentionLines(onboarding.attention);
  const recon = sc.enrollmentReconciliation;
  if (recon.enrolledUnpaid.length) attention.push(`Enrolled in GHL without a Stripe first payment on the day: ${recon.enrolledUnpaid.map((x) => x.name).join(', ')}.`);
  if (rev.unclassifiedCount > 0) attention.push(`${rev.unclassifiedCount} succeeded payment(s) have no payment class — run npm run reclassify:payments.`);

  const sections: ReportSection[] = [
    { type: 'stats', title: 'Funnel', hint: maturity.active ? `GHL stage entries on the day · maturing data: ${maturingCaveatText(maturity)}` : 'GHL stage entries on the day', cards: funnelCards },
    { type: 'stats', title: 'Money and spend', hint: `${sc.currency} · vs ${against}`, cards: moneyCards },
    { type: 'stats', title: 'Onboarding', hint: onboarding.users.length ? onboarding.users.map((u) => u.name).join(', ') : undefined, cards: onboardingCards(onboarding.numbers) },
    callsTable(onboarding, { withDate: false }),
  ];
  if (onboarding.reason) sections.push({ type: 'text', title: 'Onboarding', text: onboarding.reason, tone: 'warn' });

  // ---- Follow-ups (the retired daily to-do, kept as the last section) -------------------------------------
  if (todo) {
    const b = todo.buckets;
    const lines: string[] = [];
    const bucket = (label: string, rows: Record<TodoKind, Array<{ name: string; on: string }>>) => {
      for (const k of ['applied_no_booking', 'consult_noshow', 'roadmap_noshow'] as TodoKind[]) if (rows[k].length) lines.push(`${label} · ${TODO_LABELS[k]} (${rows[k].length}): ${rows[k].map((x) => x.name).join(', ')}`);
    };
    bucket('Day-1', b.day1);
    bucket('Day-3', b.day3);
    for (const k of ['consult_rescheduled', 'roadmap_rescheduled'] as RebookKind[]) if (b.awaitingRebook[k].length) lines.push(`${REBOOK_LABELS[k]} (${b.awaitingRebook[k].length}): ${b.awaitingRebook[k].map((x) => `${x.name} (${x.daysWaiting}d)`).join(', ')}`);
    sections.push({ type: 'lines', title: `Follow-ups for ${formatLongDate(todo.today)}`, hint: b.total ? `${b.total} to call` : undefined, lines: lines.length ? lines : ['Nothing needs a call today.'] });
  }

  const n = onboarding.numbers;
  const parts = [`${applied} applied`, `${consults} consult${consults === 1 ? '' : 's'} booked`, firstPayments === null ? `${enrolled} enrolled` : `${firstPayments} new client${firstPayments === 1 ? '' : 's'} paid`];
  const subjectText = [...parts, ...(n.needsAttention ? [`${n.needsAttention} call${n.needsAttention === 1 ? '' : 's'} need${n.needsAttention === 1 ? 's' : ''} attention`] : [])].join(', ');
  const headlineText = parts.join(', ');
  const label = formatLongDate(p.date);
  const empty = sc.empty && rev.paymentCount === 0 && ads.spendCents === 0 && n.calls === 0;
  return {
    kind: 'daily',
    period: { ...day, label },
    subject: reportSubject('daily', label, subjectText),
    headline: `${headlineText}. ${onboardingHeadline(n, 'on the day')}`,
    totals: [countCard('Applied', applied, count(sc.previousFunnel, 'applied'), against), countCard('Enrolled (GHL)', enrolled, count(sc.previousFunnel, 'enrolled'), against), moneyCards[0], { label: 'Calls', value: String(n.calls), sub: `${n.logged} logged · ${n.needsAttention} need attention`, tone: n.needsAttention ? 'bad' : 'neutral' }],
    attention,
    sections,
    health: health.line,
    button: { label: 'Open the Onboarding page', path: reportPagePath('daily', day) },
    footer: `Sent just after midnight for ${label}. Funnel counts are GoHighLevel stage entries dated by the entry; cash and first payments are Stripe's; spend is Meta's${settling ? ' and still settling' : ''}. Money ${sc.currency}. Read-only — nothing in this email changes the pipeline.`,
    empty,
  };
}
