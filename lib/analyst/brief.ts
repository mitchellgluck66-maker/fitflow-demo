/**
 * The business brief (plan item 3) — PURE. Assembled from engine calls only:
 * every KPI week by week since the first data, trailing 8- and 12-week
 * baselines (each saying how many maturing weeks it includes — amendment 2),
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
import { computeMaturity, HISTORY_DEPENDENT_METRICS } from '../metrics/maturity';
import { glossaryText, METRIC_DEFINITION_VERSION } from '../metrics/glossary';
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
  initialCents: number;
  recurringCents: number;
  spendCents: number;
  paidCacCents: number | null;
  blendedCacCents: number | null;
  roas: number | null;
  currency: Currency;
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
    initialCents: sc.revenue.awaitingStripe ? 0 : sc.revenue.initialCents,
    recurringCents: sc.revenue.awaitingStripe ? 0 : sc.revenue.recurringCents,
    spendCents: m.spendCents,
    paidCacCents: m.paidCacCents,
    blendedCacCents: m.blendedCacCents,
    roas: m.roas,
    currency: sc.currency,
  };
}

function baseline(label: string, weeks: BriefWeek[], ccy: Currency): string {
  if (weeks.length === 0) return `- ${label}: no complete weeks yet.`;
  const n = weeks.length;
  const maturing = weeks.filter((w) => w.maturing).length;
  const sum = (f: (w: BriefWeek) => number) => weeks.reduce((a, w) => a + f(w), 0);
  const applied = sum((w) => w.applied);
  const consults = sum((w) => w.consultsBooked);
  const roadmaps = sum((w) => w.roadmapsBooked);
  const enrolled = sum((w) => w.enrolled);
  const spend = sum((w) => w.spendCents);
  const initial = sum((w) => w.initialCents);
  const blended = enrolled > 0 && spend > 0 ? Math.round(spend / enrolled) : null;
  const flag = maturing > 0 ? ` Includes ${maturing} maturing week${maturing === 1 ? '' : 's'} (consults, roadmaps and stage conversions under/over-counted there); enrollments, cash, spend and CAC do not depend on that history.` : ' Includes no maturing weeks.';
  return `- ${label} (${formatRangeLabel(weeks[0].start, weeks[n - 1].end)}, ${n} weeks): per week avg ${(applied / n).toFixed(1)} applied · ${(consults / n).toFixed(1)} consults booked · ${(roadmaps / n).toFixed(1)} roadmaps booked · ${(enrolled / n).toFixed(1)} enrolled · ${money(Math.round(spend / n), ccy)} spend · ${money(Math.round(initial / n), ccy)} initial cash; totals ${applied} applied, ${enrolled} enrolled, ${money(spend, ccy)} spend, ${money(initial, ccy)} initial cash; Blended CAC from totals ${money(blended, ccy)} (recomputed from totals, never an average of weekly ratios).${flag}`;
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
    lines.push(`- Live stage-history observation began ${hcs}. Weeks before it are MATURING for ${[...HISTORY_DEPENDENT_METRICS].join(', ')} and every stage→stage conversion (marked "maturing" below): a change against one of those weeks is not a real change and must be said so. Enrollments, initial cash, spend, Paid/Blended CAC, ROAS, LTV:CAC and show rates do not depend on that history and carry no caveat.`);
    lines.push(`- Maturing weeks: ${maturingWeeks.map((w) => w.label).join('; ')}.`);
  } else {
    lines.push('- No maturing weeks: every week in this brief is inside complete stage history (or the disclaimer has sunset).');
  }
  lines.push('');

  lines.push('## Weekly KPIs since the first data (Sun–Sat weeks)');
  lines.push('week | applied | consults booked | roadmaps booked | enrolled | initial cash | recurring cash | spend | Paid CAC | Blended CAC | ROAS | flags');
  for (const w of weeks) {
    const flags = [w.partial ? 'week to date' : null, w.maturing ? 'maturing' : null].filter(Boolean).join(', ') || '—';
    lines.push(`${w.label} | ${w.applied} | ${w.consultsBooked} | ${w.roadmapsBooked} | ${w.enrolled} | ${money(w.initialCents, ccy)} | ${money(w.recurringCents, ccy)} | ${money(w.spendCents, ccy)} | ${money(w.paidCacCents, ccy)} | ${money(w.blendedCacCents, ccy)} | ${ratio(w.roas)} | ${flags}`);
  }
  lines.push('');

  lines.push('## Baselines (complete weeks only)');
  lines.push(baseline('Trailing 8 weeks', complete.slice(-8), ccy));
  lines.push(baseline('Trailing 12 weeks', complete.slice(-12), ccy));
  lines.push('');

  lines.push('## Stage conversions over time');
  lines.push('By cohort = applicants of the week and what they have reached since (no time cutoff). In period = events of the week; ratios capped at 100%.');
  lines.push('week | mode | applied→consult booked | consult booked→roadmap booked (spanning withheld "showed" stages) | roadmap booked→enrolled | applied→enrolled | flags');
  for (const w of weeks) {
    for (const mode of ['cohort', 'period'] as const) {
      const f = computeFunnel(b.input, w, mode);
      const s = (k: string) => f.stages.find((x) => x.key === k)!;
      const conv = (k: string) => {
        const st = s(k);
        return st.withheld ? 'withheld' : `${pct(st.conversionFromPrevious)}${st.capped ? ' (capped)' : ''}`;
      };
      const flags = [w.partial ? 'week to date' : null, w.maturing ? 'maturing' : null].filter(Boolean).join(', ') || '—';
      lines.push(`${w.label} | ${mode} | ${conv('consult_booked')} | ${conv('roadmap_booked')} | ${conv('enrolled')} | ${pct(s('enrolled').shareOfApplied)} | ${flags}`);
    }
  }
  lines.push('');

  lines.push('## Campaigns, week by week (API-reported spend; FitFlow-tracked counts by utm_campaign)');
  lines.push('week | campaign | platform | spend | impressions | link clicks | applied (tracked) | enrolled (tracked) | initial cash (matched) | ROAS (tracked)');
  let campaignRows = 0;
  for (const w of weeks) {
    for (const c of computeCampaignTable(b.input, w)) {
      if (c.spendCents === 0 && c.tracked.applied === 0) continue;
      campaignRows += 1;
      const tracked = c.from === 'api' && c.tracked.applied === 0 ? 'not tracked yet' : `${c.tracked.applied}`;
      lines.push(`${w.label} | ${c.campaignName} | ${c.platform} | ${money(c.spendCents, c.currency)} | ${c.impressions} | ${c.linkClicks} | ${tracked} | ${c.tracked.enrolled} | ${money(c.initialCents, c.currency)} | ${ratio(c.roas)}`);
    }
  }
  if (campaignRows === 0) lines.push('(no campaign rows yet)');
  lines.push('');

  lines.push('## Revenue by month (calendar months, net of refunds)');
  lines.push('month | initial cash | recurring cash | collected | refunds | still-unpaid invoices');
  let m = monthStart(b.firstData);
  while (m <= b.today) {
    const r = { start: m, end: monthEnd(m) };
    const rev = computeRevenue(b.input, r);
    if (rev.awaitingStripe) lines.push(`${m.slice(0, 7)} | awaiting Stripe`);
    else lines.push(`${m.slice(0, 7)}${r.end >= b.today ? ' (month to date)' : ''} | ${money(rev.initialCents, ccy)} | ${money(rev.recurringCents, ccy)} | ${money(rev.collectedCents, ccy)} | ${money(rev.refundedCents, ccy)} | ${rev.failedCount}`);
    m = monthStart(addDays(monthEnd(m), 1));
  }
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
  lines.push(glossaryText());

  const text = lines.join('\n');
  const hash = createHash('sha256').update(text).digest('hex');
  return { text, hash, dataThrough, weeks };
}
