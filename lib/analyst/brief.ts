/**
 * The business brief (plan item 3) — PURE. Assembled from engine calls only:
 * every KPI week by week since the first data, trailing 8- and 12-week
 * baselines (stage-history metrics over the clean weeks only — amendment 2, redone 2026-10-06),
 * conversions over time in both funnel modes, per-campaign weekly history,
 * the revenue split by month, seasonality computed from the series, the
 * glossary, the decisions log, the owner profile (with its gaps — amendment
 * 4) and the ACTIVE owner notes.
 *
 * The brief carries no freshness or build time (markers move hourly), so its
 * hash changes only when data, the profile or the notes change — and the
 * prompt cache keeps hitting. It orients the model; it is not citeable — every
 * number the Analyst shows must come from a tool result.
 */

import { createHash } from 'node:crypto';
import {
  computeCampaignTable,
  computeFunnel,
  computeRevenue,
  computeScorecard,
  formatCents,
  formatPct,
  type Currency,
  type MetricsInput,
} from '../metrics';
import { computeMaturity, HISTORY_DEPENDENT_LABEL, HISTORY_INDEPENDENT_LABEL } from '../metrics/maturity';
import { cleanBaseline } from '../metrics/baseline';
import { computeSpendGates } from '../metrics/spendGate';
import { glossaryBriefText, METRIC_DEFINITION_VERSION } from '../metrics/glossary';
import { weekBuckets, formatRangeLabel, addDays, monthStart, monthEnd } from '../dates';
import { profileGaps, withheldLine, type OwnerProfile } from './notes';

export interface BriefNote {
  text: string;
  createdAt: string;
}

export interface BriefInputs {
  timezone: string;
  /** Today's local date; the brief covers complete days up to yesterday. */
  today: string;
  /** Rows from `firstData` to today (lib/metrics/load.ts). */
  input: MetricsInput;
  /** The earliest date with data (settings.backfill_from). */
  firstData: string;
  historyCompleteSince: string | null;
  disclaimerSunset: string | null;
  profile: OwnerProfile;
  /** ACTIVE notes only — the caller must never pass proposed ones. */
  notes: BriefNote[];
}

export interface BriefWeek {
  start: string;
  end: string;
  label: string;
  partial: boolean;
  /** History-dependent metrics of this week are maturing (before history_complete_since, before the sunset). */
  maturing: boolean;
  applied: number;
  consultsBooked: number;
  roadmapsBooked: number;
  enrolled: number;
  /** Stripe first payments in the week — the ground truth for "new clients". */
  newPayingClients: number;
  initialCents: number;
  recurringCents: number;
  spendCents: number;
  /** Paid-attributed enrollments and initial cash — so a month rollup recomputes Paid CAC and ROAS from totals. */
  paidEnrollments: number;
  paidInitialCents: number;
  paidCacCents: number | null;
  blendedCacCents: number | null;
  roas: number | null;
  currency: Currency;
}

/**
 * Wave 2 tune-up 2 (2026-10-15): the brief is BOUNDED whatever the tenant's age. The three per-week sections
 * (weekly KPIs, conversions, campaigns) carry the trailing `BRIEF_FULL_WEEKS` complete weeks in full (plus the week
 * to date); every earlier complete week is rolled up ONE row per calendar month (sums; ratios recomputed from the
 * totals, never averaged). A two-year-old tenant adds ~24 month rows, not ~100 week rows.
 */
export const BRIEF_FULL_WEEKS = 12;

/** A month rollup of the weeks that START in that month (Sun–Sat weeks never split). */
export interface BriefMonth {
  month: string;
  label: string;
  start: string;
  end: string;
  weeks: BriefWeek[];
  maturingWeeks: number;
}

export interface Brief {
  text: string;
  hash: string;
  dataThrough: string;
  weeks: BriefWeek[];
}

/** Decisions on record — the definitions the numbers already obey. Restated here so the model never re-litigates them. */
export const DECISIONS_LOG: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'C1', text: 'One reporting currency (CAD by default). Stored amounts keep the currency they were charged in; the engine converts at read time at each row\'s own date from the Bank of Canada rate. Every amount carries its code.' },
  { id: 'F13', text: 'The Meta ad account bills in CAD; every Meta run reads the account currency and fails closed without it.' },
  { id: 'F14', text: 'Applied = the application: the followed-pipeline opportunity\'s creation date, never the contact\'s creation date. A returning contact who re-applies counts again.' },
  { id: 'Applied caveat', text: 'The Applied definition is under review (docs/deferred.md #1). The dashboard states, per range, how many counted applications have no application-form record and how many form applicants sit in other pipelines. State this whenever you cite Applied or cost per lead.' },
  { id: 'F2', text: 'A show rate is withheld — never a fabricated 0% — while fewer than 90% of the past appointments of that type have a recorded outcome. A withheld "showed" stage is skipped by the conversion chain.' },
  { id: 'F4', text: 'Stage roles are read at query time from the current mapping; a remap changes history consistently.' },
  { id: 'F9', text: 'Cohort mode counts "reached this stage or any later one", so every stage is a subset of the one before and no conversion exceeds 100%. In-period ratios are capped at 100% and flagged.' },
  { id: 'M3', text: 'Payment classes: a customer\'s first kept charge is initial (new-client cash), later kept charges are recurring; failed, pending, fully refunded and refund rows are excluded. Failed payments count once per invoice; refunds inherit the parent charge\'s customer.' },
  { id: 'Marketing math', text: 'ROAS = paid-attributed initial cash ÷ spend. Paid CAC = spend ÷ paid-attributed enrollments. Blended CAC = spend ÷ all enrollments. LTV:CAC = Σ contract value of new clients ÷ spend, withheld while any new client has no contract value. Organic and unclassified never leak into the paid figures.' },
  { id: 'Weeks', text: 'Weeks are Sunday–Saturday in the business timezone (Meta convention). Day boundaries are local, never UTC.' },
];

const money = (cents: number | null, ccy: Currency) => formatCents(cents, ccy);
const ratio = (r: number | null) => (r === null ? '—' : `${r.toFixed(2)}×`);
const pct = (r: number | null) => formatPct(r, 1);

function weekRow(input: MetricsInput, w: { start: string; end: string; label: string }, today: string, hcs: string | null, sunset: string | null): BriefWeek {
  const sc = computeScorecard(input, w, null, null);
  const m = sc.marketing;
  const maturity = computeMaturity({ range: w, today, historyCompleteSince: hcs, sunset });
  return {
    start: w.start,
    end: w.end,
    label: w.label,
    partial: w.end >= today,
    maturing: maturity.active,
    applied: sc.kpis.applied.current ?? 0,
    consultsBooked: sc.kpis.consultsBooked.current ?? 0,
    roadmapsBooked: sc.kpis.roadmapsBooked.current ?? 0,
    enrolled: sc.kpis.enrollments.current ?? 0,
    newPayingClients: sc.revenue.awaitingStripe ? 0 : sc.revenue.initialCount,
    initialCents: sc.revenue.awaitingStripe ? 0 : sc.revenue.initialCents,
    recurringCents: sc.revenue.awaitingStripe ? 0 : sc.revenue.recurringCents,
    spendCents: m.spendCents,
    paidEnrollments: m.paidEnrollments,
    paidInitialCents: m.paidInitialCents,
    paidCacCents: m.paidCacCents,
    blendedCacCents: m.blendedCacCents,
    roas: m.roas,
    currency: sc.currency,
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The weeks shown in full (the last BRIEF_FULL_WEEKS complete ones + the week to date) and the earlier ones by month. */
export function splitWeeks(weeks: BriefWeek[]): { full: BriefWeek[]; months: BriefMonth[] } {
  const partialAtEnd = weeks.length && weeks[weeks.length - 1].partial ? 1 : 0;
  const cut = Math.max(0, weeks.length - partialAtEnd - BRIEF_FULL_WEEKS);
  const earlier = weeks.slice(0, cut);
  const full = weeks.slice(cut);
  const byMonth = new Map<string, BriefWeek[]>();
  for (const w of earlier) byMonth.set(w.start.slice(0, 7), [...(byMonth.get(w.start.slice(0, 7)) ?? []), w]);
  const months: BriefMonth[] = [...byMonth.entries()].map(([month, ws]) => ({
    month,
    label: `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)} (${ws.length} wk${ws.length === 1 ? '' : 's'})`,
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    weeks: ws,
    maturingWeeks: ws.filter((w) => w.maturing).length,
  }));
  return { full, months };
}

/** A month's KPI row from its weeks' totals: counts and cash summed; CAC / ROAS recomputed from the totals. */
export function rollupWeeks(ws: BriefWeek[]): Omit<BriefWeek, 'start' | 'end' | 'label' | 'partial' | 'maturing'> {
  const sum = (f: (w: BriefWeek) => number) => ws.reduce((a, w) => a + f(w), 0);
  const spendCents = sum((w) => w.spendCents);
  const enrolled = sum((w) => w.enrolled);
  const paidEnrollments = sum((w) => w.paidEnrollments);
  const paidInitialCents = sum((w) => w.paidInitialCents);
  return {
    applied: sum((w) => w.applied),
    consultsBooked: sum((w) => w.consultsBooked),
    roadmapsBooked: sum((w) => w.roadmapsBooked),
    enrolled,
    newPayingClients: sum((w) => w.newPayingClients),
    initialCents: sum((w) => w.initialCents),
    recurringCents: sum((w) => w.recurringCents),
    spendCents,
    paidEnrollments,
    paidInitialCents,
    paidCacCents: spendCents > 0 && paidEnrollments > 0 ? Math.round(spendCents / paidEnrollments) : null,
    blendedCacCents: spendCents > 0 && enrolled > 0 ? Math.round(spendCents / enrolled) : null,
    roas: spendCents > 0 ? paidInitialCents / spendCents : null,
    currency: ws[0]?.currency ?? 'CAD',
  };
}

const monthFlags = (m: BriefMonth) => (m.maturingWeeks === 0 ? 'month rollup' : m.maturingWeeks === m.weeks.length ? 'month rollup, maturing' : `month rollup, maturing (${m.maturingWeeks} of ${m.weeks.length} weeks)`);

/** A month with nothing in it (before the tenant connected anything) — collapsed into one "no data" line, never 24 rows of zeros. */
export function emptyMonth(r: ReturnType<typeof rollupWeeks>): boolean {
  return r.applied === 0 && r.consultsBooked === 0 && r.roadmapsBooked === 0 && r.enrolled === 0 && r.newPayingClients === 0 && r.initialCents === 0 && r.recurringCents === 0 && r.spendCents === 0;
}

/** Runs of empty months become one line each; the rest are listed through `row`. */
function monthRows(months: BriefMonth[], row: (m: BriefMonth, r: ReturnType<typeof rollupWeeks>) => void, noData: (first: BriefMonth, last: BriefMonth, n: number) => string): string[] {
  const out: string[] = [];
  let run: BriefMonth[] = [];
  const flush = () => {
    if (run.length) out.push(noData(run[0], run[run.length - 1], run.length));
    run = [];
  };
  for (const m of months) {
    const r = rollupWeeks(m.weeks);
    if (emptyMonth(r)) run.push(m);
    else {
      flush();
      row(m, r);
    }
  }
  flush();
  return out;
}

function baseline(label: string, candidate: BriefWeek[], ccy: Currency, settings: { historyCompleteSince: string | null; sunset: string | null; today: string }): string {
  if (candidate.length === 0) return `- ${label}: no complete weeks yet.`;
  const buckets = candidate.map((w) => ({ start: w.start, end: w.end, label: w.label }));
  // THE baseline rule (lib/metrics/baseline.ts): stage-history metrics over the clean weeks only; source-dated over every week.
  const stage = cleanBaseline({ candidate: buckets, metric: 'enrollments', ...settings });
  const source = cleanBaseline({ candidate: buckets, metric: 'initial_cash', ...settings });
  const byStart = new Map(candidate.map((w) => [w.start, w]));
  const avg = (ws: typeof buckets, f: (w: BriefWeek) => number) => (ws.length ? ws.reduce((a, w) => a + f(byStart.get(w.start)!), 0) / ws.length : null);
  const n1 = (n: number | null) => (n === null ? '—' : n.toFixed(1));
  const stageLine = stage.enough
    ? `enrolled ${n1(avg(stage.weeks, (w) => w.enrolled))}/week · consults booked ${n1(avg(stage.weeks, (w) => w.consultsBooked))}/week · roadmaps booked ${n1(avg(stage.weeks, (w) => w.roadmapsBooked))}/week`
    : `enrolled / consults / roadmaps per week: not computed — ${stage.note}`;
  const spend = avg(source.weeks, (w) => w.spendCents);
  const initial = avg(source.weeks, (w) => w.initialCents);
  const paying = avg(source.weeks, (w) => w.newPayingClients);
  const sourceLine = `applied ${n1(avg(source.weeks, (w) => w.applied))}/week · new paying clients (Stripe first payments) ${n1(paying)}/week · initial cash ${money(initial === null ? null : Math.round(initial), ccy)}/week · spend ${money(spend === null ? null : Math.round(spend), ccy)}/week`;
  const totalsStage = stage.enough ? `; Blended CAC from the clean weeks' totals ${money((() => { const e = stage.weeks.reduce((a, w) => a + byStart.get(w.start)!.enrolled, 0); const sp = stage.weeks.reduce((a, w) => a + byStart.get(w.start)!.spendCents, 0); return e > 0 && sp > 0 ? Math.round(sp / e) : null; })(), ccy)} (recomputed from totals, never an average of weekly ratios)` : '';
  return `- ${label}: stage-history metrics over ${stage.summary} — ${stageLine}${totalsStage}. Source-dated metrics over ${source.summary} — ${sourceLine}. A week is judged against THESE figures; the GHL "enrolled" count of a maturing week is never a baseline.`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function buildBrief(b: BriefInputs): Brief {
  const dataThrough = addDays(b.today, -1);
  const ccy = b.input.money?.reporting ?? 'CAD';
  const allWeeks = weekBuckets(b.firstData, b.today);
  const weeks = allWeeks.map((w) => weekRow(b.input, w, b.today, b.historyCompleteSince, b.disclaimerSunset));
  const complete = weeks.filter((w) => !w.partial);
  const lines: string[] = [];

  lines.push('# FitFlow business brief');
  lines.push(`Data through ${dataThrough} (complete local days, ${b.timezone}). Reporting currency ${ccy}. Metric definitions version ${METRIC_DEFINITION_VERSION}.`);
  lines.push('This brief orients you. It is NOT citeable: every number you show must come from a tool result in this conversation, with its ref.');
  lines.push('');

  lines.push('## The business');
  lines.push('The Fit Physician: a fitness coaching business for physicians. Funnel: application form → consult call → roadmap call → enrolled (client). Sources: Meta ads (account bills CAD), Google ads, referrals, organic. Money: Stripe (about 63% CAD, the rest USD). Pipeline: GoHighLevel (read-only mirror). The owner reads the Command Center weekly: initial cash collected, enrollments, Paid CAC, Blended CAC, ROAS; then LTV:CAC, consults booked, cost per roadmap booked.');
  const p = b.profile;
  const gaps = profileGaps(p);
  lines.push('');
  lines.push('## Owner profile');
  lines.push(`- Goals: ${p.goals.trim() || '(not filled in)'}`);
  lines.push(`- Offers: ${p.offers.length ? p.offers.map((o) => `${o.name} ${money(o.priceCents, o.currency)}`).join('; ') : '(not filled in)'}`);
  lines.push(`- Gross margin: ${p.grossMarginPct !== null ? `${p.grossMarginPct}%` : '(not filled in)'}`);
  lines.push(`- Target CAC: ${p.targetCacCents !== null ? money(p.targetCacCents, ccy) : '(not filled in)'}`);
  lines.push(`- Monthly revenue target: ${p.monthlyRevenueTargetCents !== null ? money(p.monthlyRevenueTargetCents, ccy) : '(not filled in)'}`);
  lines.push(`- Team: ${p.team.trim() || '(not filled in)'}`);
  lines.push(`- What a good week looks like: ${p.goodWeek.trim() || '(not filled in)'}`);
  const withheld = withheldLine(gaps);
  if (withheld) lines.push(`- ${withheld}. Name the missing field instead of estimating; a value you estimate in its place has no ref and fails verification.`);
  lines.push('');

  lines.push('## Owner notes (active, dated)');
  if (b.notes.length === 0) lines.push('- none yet');
  for (const n of [...b.notes].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) lines.push(`- ${n.createdAt.slice(0, 10)}: ${n.text}`);
  lines.push('');

  lines.push('## Decisions on record');
  for (const d of DECISIONS_LOG) lines.push(`- ${d.id}: ${d.text}`);
  lines.push('');

  lines.push('## Data caveats');
  const hcs = b.historyCompleteSince ?? '2026-09-01';
  const maturingWeeks = weeks.filter((w) => w.maturing);
  if (maturingWeeks.length) {
    lines.push(`- Live stage-history observation began ${hcs}. Weeks before it are MATURING for ${HISTORY_DEPENDENT_LABEL} (marked "maturing" below): a change against one of those weeks is not a real change and must be said so, and the baselines above EXCLUDE those weeks for these metrics. ${HISTORY_INDEPENDENT_LABEL} are dated by their own source and carry no caveat. A new client is a Stripe first payment; a GHL "enrolled" entry is a stage move.`);
    lines.push(maturingWeeks.length <= 8 ? `- Maturing weeks: ${maturingWeeks.map((w) => w.label).join('; ')}.` : `- Maturing weeks: ${maturingWeeks.length}, ${maturingWeeks[0].label} to ${maturingWeeks[maturingWeeks.length - 1].label}.`);
  } else {
    lines.push('- No maturing weeks: every week in this brief is inside complete stage history (or the disclaimer has sunset).');
  }
  lines.push('');

  const { full, months } = splitWeeks(weeks);
  lines.push(`## Weekly KPIs since the first data (Sun–Sat weeks; the last ${BRIEF_FULL_WEEKS} complete weeks in full, earlier weeks rolled up by month — ratios from totals)`);
  lines.push('week | applied | consults booked | roadmaps booked | enrolled (GHL stage entries) | paid (Stripe first payments) | initial cash | recurring cash | spend | Paid CAC | Blended CAC | ROAS | flags');
  const kpiRow = (label: string, w: ReturnType<typeof rollupWeeks>, flags: string) => `${label} | ${w.applied} | ${w.consultsBooked} | ${w.roadmapsBooked} | ${w.enrolled} | ${w.newPayingClients} | ${money(w.initialCents, ccy)} | ${money(w.recurringCents, ccy)} | ${money(w.spendCents, ccy)} | ${money(w.paidCacCents, ccy)} | ${money(w.blendedCacCents, ccy)} | ${ratio(w.roas)} | ${flags}`;
  for (const l of monthRows(months, (m, r) => lines.push(kpiRow(m.label, r, monthFlags(m))), (a, b, n) => `${a.label} – ${b.label}: no data (${n} month${n === 1 ? '' : 's'})`)) lines.push(l);
  for (const w of full) {
    const flags = [w.partial ? 'week to date' : null, w.maturing ? 'maturing' : null].filter(Boolean).join(', ') || '—';
    lines.push(kpiRow(w.label, w, flags));
  }
  lines.push('');

  lines.push('## Baselines (complete weeks only)');
  const settings = { historyCompleteSince: b.historyCompleteSince, sunset: b.disclaimerSunset, today: b.today };
  lines.push(baseline('Trailing 8 weeks', complete.slice(-8), ccy, settings));
  lines.push(baseline('Trailing 12 weeks', complete.slice(-12), ccy, settings));
  lines.push('');

  lines.push('## Stage conversions over time');
  lines.push('By cohort = applicants of the week and what they have reached since (no time cutoff). In period = events of the week; ratios capped at 100%.');
  lines.push('week | mode | applied→consult booked | consult booked→roadmap booked (spanning withheld "showed" stages) | roadmap booked→enrolled | applied→enrolled | flags');
  const convRow = (label: string, range: { start: string; end: string }, flags: string) => {
    for (const mode of ['cohort', 'period'] as const) {
      const f = computeFunnel(b.input, range, mode);
      const s = (k: string) => f.stages.find((x) => x.key === k)!;
      const conv = (k: string) => {
        const st = s(k);
        return st.withheld ? 'withheld' : `${pct(st.conversionFromPrevious)}${st.capped ? ' (capped)' : ''}`;
      };
      lines.push(`${label} | ${mode} | ${conv('consult_booked')} | ${conv('roadmap_booked')} | ${conv('enrolled')} | ${pct(s('enrolled').shareOfApplied)} | ${flags}`);
    }
  };
  monthRows(months, (m) => convRow(m.label, { start: m.start, end: m.end }, monthFlags(m)), () => '');
  for (const w of full) convRow(w.label, w, [w.partial ? 'week to date' : null, w.maturing ? 'maturing' : null].filter(Boolean).join(', ') || '—');
  lines.push('');

  lines.push('## Campaigns, week by week (API-reported spend; FitFlow-tracked counts by utm_campaign; impressions, clicks, CPM via get_campaigns)');
  lines.push('week | campaign | platform | spend | applied (tracked) | enrolled (tracked) | initial cash (matched) | ROAS (tracked)');
  let campaignRows = 0;
  const campaignRow = (label: string, range: { start: string; end: string }) => {
    for (const c of computeCampaignTable(b.input, range)) {
      if (c.spendCents === 0 && c.tracked.applied === 0) continue;
      campaignRows += 1;
      const tracked = c.from === 'api' && c.tracked.applied === 0 ? 'not tracked yet' : `${c.tracked.applied}`;
      lines.push(`${label} | ${c.campaignName} | ${c.platform} | ${money(c.spendCents, c.currency)} | ${tracked} | ${c.tracked.enrolled} | ${money(c.initialCents, c.currency)} | ${ratio(c.roas)}`);
    }
  };
  for (const m of months) campaignRow(m.label, { start: m.start, end: m.end });
  for (const w of full) campaignRow(w.label, w);
  if (campaignRows === 0) lines.push('(no campaign rows yet)');
  lines.push('');

  // Oct 7 item 1: the spend gates over the clean trailing window — computed by code; a hold is the advice.
  lines.push('## Spend gates (computed by the server over the clean trailing 8 complete weeks; the Analyst never argues past a hold)');
  const gateWeeks = cleanBaseline({ candidate: complete.slice(-8).map((w) => ({ start: w.start, end: w.end, label: w.label })), metric: 'enrollments', historyCompleteSince: b.historyCompleteSince, sunset: b.disclaimerSunset, today: b.today });
  const gates = computeSpendGates(b.input, gateWeeks.weeks, gateWeeks.enough ? null : gateWeeks.note);
  for (const g of [gates.account, ...gates.campaigns]) lines.push(`- ${g.campaign}${g.platform ? ` (${g.platform})` : ''}: ${g.decision === 'may_change' ? 'may change' : 'HOLD'} — ${g.reason}`);
  lines.push('');

  lines.push('## Revenue by month (calendar months, net of refunds)');
  lines.push('month | initial cash | recurring cash | collected | refunds | still-unpaid invoices');
  let m = monthStart(b.firstData);
  let quiet: string[] = [];
  const flushQuiet = () => {
    if (quiet.length) lines.push(`${quiet[0]}${quiet.length > 1 ? ` – ${quiet[quiet.length - 1]}` : ''} | no Stripe activity (${quiet.length} month${quiet.length === 1 ? '' : 's'})`);
    quiet = [];
  };
  while (m <= b.today) {
    const r = { start: m, end: monthEnd(m) };
    const rev = computeRevenue(b.input, r);
    if (rev.awaitingStripe) lines.push(`${m.slice(0, 7)} | awaiting Stripe`);
    else if (r.end < b.today && rev.initialCents === 0 && rev.recurringCents === 0 && rev.collectedCents === 0 && rev.refundedCents === 0 && rev.failedCount === 0) quiet.push(m.slice(0, 7));
    else {
      flushQuiet();
      lines.push(`${m.slice(0, 7)}${r.end >= b.today ? ' (month to date)' : ''} | ${money(rev.initialCents, ccy)} | ${money(rev.recurringCents, ccy)} | ${money(rev.collectedCents, ccy)} | ${money(rev.refundedCents, ccy)} | ${rev.failedCount}`);
    }
    m = monthStart(addDays(monthEnd(m), 1));
  }
  flushQuiet();
  lines.push('');

  lines.push('## Seasonality (computed from the series above)');
  if (complete.length >= 2) {
    const best = (f: (w: BriefWeek) => number, label: string) => {
      const sorted = [...complete].sort((x, y) => f(y) - f(x));
      return `- ${label}: best week ${sorted[0].label} (${f(sorted[0])}), worst week ${sorted[sorted.length - 1].label} (${f(sorted[sorted.length - 1])}).`;
    };
    lines.push(best((w) => w.applied, 'Applied'));
    lines.push(best((w) => w.enrolled, 'Enrollments'));
    const byDay = new Array(7).fill(0) as number[];
    let total = 0;
    for (const c of b.input.contacts) {
      if (c.appliedOn && c.appliedOn >= b.firstData && c.appliedOn <= dataThrough) {
        byDay[weekday(c.appliedOn)] += 1;
        total += 1;
      }
    }
    if (total > 0) lines.push(`- Applications by weekday (${total} total): ${byDay.map((n, i) => `${WEEKDAYS[i]} ${formatPct(n / total)}`).join(', ')}.`);
    const half = Math.floor(complete.length / 2);
    if (half >= 2) {
      const avg = (ws: BriefWeek[], f: (w: BriefWeek) => number) => ws.reduce((a, w) => a + f(w), 0) / ws.length;
      const first = complete.slice(0, half);
      const last = complete.slice(-half);
      lines.push(`- Trend: applied averaged ${avg(first, (w) => w.applied).toFixed(1)}/week in the first ${half} complete weeks vs ${avg(last, (w) => w.applied).toFixed(1)}/week in the last ${half}; enrollments ${avg(first, (w) => w.enrolled).toFixed(1)} vs ${avg(last, (w) => w.enrolled).toFixed(1)}.`);
    }
  } else {
    lines.push('- Fewer than two complete weeks: no seasonality yet.');
  }
  lines.push('');

  lines.push('## Metric glossary (the single source of definitions)');
  lines.push(glossaryBriefText());

  const text = lines.join('\n');
  const hash = createHash('sha256').update(text).digest('hex');
  return { text, hash, dataThrough, weeks };
}
