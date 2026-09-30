/**
 * FitFlow acceptance harness (READ-ONLY) — Ingestion v2 / Wave 2, 2026-09-30. Supersedes verify-2026-09-29.
 *
 *   npx tsx scripts/verify.ts            # engine vs independent SQL + sources + health → docs/verification-<date>.md
 *   npx tsx scripts/verify.ts engine     # engine vs SQL only
 *   npx tsx scripts/verify.ts sources    # provider comparisons + health only
 *
 * Ranges are dynamic (business timezone): last full Sun–Sat week, last calendar month, month to date, Jul 16 → today.
 * Every provider call goes through the app's own read-only clients (GHL: ghlRequest, GET only — verify:readonly).
 * Nothing is written to the database. No secret is printed. Outputs: docs/verification/<date>/*.json|txt and
 * docs/verification-<date>.md. Exit code 0 = every check PASS, 1 = a FAIL, 2 = refused to run.
 */
import fs from 'fs';
import path from 'path';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, pipelines, stages, ghlOpportunities, syncRuns, fxRates, adSpend } from '../db';
import { getTimezone } from '../lib/settings';
import { resolvePreset, rangeToInstants, todayInTimezone } from '../lib/dates';
import { loadMetricsInput } from '../lib/metrics/load';
import { getScorecard } from '../lib/metrics/service';
import { computeFunnel, computeMarketing, computeRevenueSummary, computeShowRates, computeAdsKpis, computeCampaignTable, type MetricsInput } from '../lib/metrics';
import { getGhlConfig } from '../lib/ghl/config';
import { listAllOpportunities, countOpportunities, OPPORTUNITY_STATUSES } from '../lib/ghl/client';
import { readReconcileSummary } from '../lib/ghl/reconcile';
import { readAppliedSummary } from '../lib/reconcile/appliedLedger';
import { getStripeConfig } from '../lib/stripe/config';
import { listAll } from '../lib/stripe/client';
import { getMetaConfig } from '../lib/meta/config';
import { fetchAccount, fetchAccountDailySpend } from '../lib/meta/client';
import { fetchBocRates } from '../lib/fx/boc';
import { readMarker, type MarkerFamily } from '../lib/sync/markers';

type Range = { key: string; label: string; start: string; end: string };
type Check = { section: string; name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const check = (section: string, name: string, ok: boolean, detail: string) => {
  checks.push({ section, name, ok, detail });
  if (!ok) console.log(`FAIL  ${section} · ${name} — ${detail}`);
};
const rows = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> => {
  const r = (await db.execute(q)) as unknown;
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
};
const strip = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (k, v) => (k === 'contactIds' || k === 'payments' ? (Array.isArray(v) ? `[${v.length}]` : v) : v)));

function rangesFor(today: string): Range[] {
  const week = resolvePreset('last_week', today);
  const month = resolvePreset('last_month', today);
  const mtd = resolvePreset('this_month', today);
  return [
    { key: 'week', label: `Last full Sun–Sat week (${week.resolvedLabel})`, start: week.start, end: week.end },
    { key: 'month', label: `Last calendar month (${month.resolvedLabel})`, start: month.start, end: month.end },
    { key: 'mtd', label: `Month to date (${mtd.start} – ${today})`, start: mtd.start, end: today },
    { key: 'jul16', label: `Jul 16 → today (${today})`, start: '2026-07-16', end: today },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Engine vs independent SQL, field by field, both currencies, at ONE instant (asOf) for the show-rate rule.
async function engineVsSql(RANGES: Range[], tz: string, asOf: Date, OUT: string) {
  const engine: Record<string, unknown> = {};
  const indep: Record<string, unknown> = {};
  const lines: string[] = [];
  let pass = 0;
  let fail = 0;
  const cmp = (range: string, ccy: string, metric: string, sqlV: unknown, appV: unknown) => {
    const norm = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'number' ? Number(v.toFixed(6)) : v);
    const ok = JSON.stringify(norm(sqlV)) === JSON.stringify(norm(appV));
    if (ok) pass += 1;
    else fail += 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${range.padEnd(6)} ${ccy.padEnd(4)} ${metric.padEnd(36)} sql=${JSON.stringify(norm(sqlV))}  app=${JSON.stringify(norm(appV))}`);
  };
  const per = (spend: number | null, n: number | null | undefined) => (n && n > 0 && spend && spend > 0 ? Math.round(spend / n) : null);
  const tmpl = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify.sql'), 'utf8');

  for (const r of RANGES) {
    const served = await getScorecard({ start: r.start, end: r.end });
    const starts = [served.range.start, served.comparison.range?.start ?? served.range.start, served.baseline.start].sort();
    const ends = [served.range.end, served.comparison.range?.end ?? served.range.end, served.baseline.end].sort();
    const base = await loadMetricsInput({ start: starts[0], end: ends.at(-1)!, timezone: tz });
    base.asOfMs = asOf.getTime(); // the SQL uses the same instant for "past appointments"
    const byCcy: Record<string, any> = {};
    for (const ccy of ['CAD', 'USD'] as const) {
      const input: MetricsInput = { ...base, money: { ...base.money!, reporting: ccy } };
      const range = { start: r.start, end: r.end };
      const period = computeFunnel(input, range, 'period');
      const cohort = computeFunnel(input, range, 'cohort');
      byCcy[ccy] = {
        funnelPeriod: Object.fromEntries(period.stages.map((s) => [s.key, s.count])),
        funnelPeriodPreviousLeads: period.previousLeads.count,
        funnelCohort: Object.fromEntries(cohort.stages.map((s) => [s.key, s.count])),
        funnelCohortPreviousLeads: cohort.previousLeads.count,
        marketing: strip(computeMarketing(input, range)),
        revenue: strip(computeRevenueSummary(input, range)),
        showRates: computeShowRates(input, range),
        ads: strip(computeAdsKpis(input, range)),
        campaigns: computeCampaignTable(input, range).map((c) => ({ key: c.key, name: c.campaignName, spendCents: c.spendCents })),
      };
    }
    engine[r.key] = { range: r, served: { currency: served.money.currency, fx: served.money.fx, marketing: strip(served.scorecard.marketing), inputHealth: served.inputHealth ?? null }, byCcy };

    const q = tmpl.replace(/\{S\}/g, r.start).replace(/\{E\}/g, r.end).replace(/\{TZ\}/g, tz).replace(/\{ASOF\}/g, asOf.toISOString()).replace(/^--.*$/gm, '');
    const res = await rows<{ out: any }>(sql.raw(q));
    const S = typeof res[0].out === 'string' ? JSON.parse(res[0].out) : res[0].out;
    indep[r.key] = S;

    for (const ccy of ['CAD', 'USD']) {
      const A = byCcy[ccy];
      const B = S.by_ccy[ccy];
      const n = (x: unknown) => Number(x ?? 0);
      const P = S.period ?? {};
      const C = S.cohort ?? {};
      const att = S.enrolled_by_att ?? {};
      const ia = B.initial_by_att ?? {};
      const spend = n(B.spend);
      for (const k of ['applied', 'consult_booked', 'consult_showed', 'roadmap_booked', 'roadmap_showed', 'enrolled']) {
        cmp(r.key, ccy, `funnel.period.${k}`, n(P[k]), A.funnelPeriod[k]);
        cmp(r.key, ccy, `funnel.cohort.${k}`, n(C[k]), A.funnelCohort[k]);
      }
      cmp(r.key, ccy, 'funnel.period.previousLeads', n(S.period_previous_leads), A.funnelPeriodPreviousLeads);
      cmp(r.key, ccy, 'funnel.cohort.previousLeads', n(S.cohort_previous_leads), A.funnelCohortPreviousLeads);
      const M = A.marketing;
      const R = A.revenue;
      const K = A.ads;
      cmp(r.key, ccy, 'spendCents', spend, M.spendCents);
      cmp(r.key, ccy, 'enrollments', n(P.enrolled), M.enrollments);
      cmp(r.key, ccy, 'enrollments.paid', n(att.paid), M.paidEnrollments);
      cmp(r.key, ccy, 'enrollments.organic', n(att.organic), M.organicEnrollments);
      cmp(r.key, ccy, 'initialCents', n(B.initial_c), M.initialCents);
      cmp(r.key, ccy, 'initialCents.paid', n(ia.paid?.cents), M.paidInitialCents);
      cmp(r.key, ccy, 'contractValueCents', n(B.contract_value), M.contractValueCents);
      cmp(r.key, ccy, 'contractValueMissing', n(B.contract_missing), M.contractValueMissing.length);
      const enr = n(P.enrolled);
      cmp(r.key, ccy, 'paidCacCents', per(spend, n(att.paid)), M.paidCacCents);
      cmp(r.key, ccy, 'blendedCacCents', per(spend, enr), M.blendedCacCents);
      cmp(r.key, ccy, 'roas (paid initial ÷ spend)', S.has_stripe && spend > 0 ? n(ia.paid?.cents) / spend : null, M.roas);
      cmp(r.key, ccy, 'ltvToCac', enr > 0 && spend > 0 && n(B.contract_missing) === 0 && n(B.contract_value) > 0 ? n(B.contract_value) / spend : null, M.ltvToCac);
      cmp(r.key, ccy, 'costPerLeadCents', per(spend, n(P.applied)), K.costPerLeadCents);
      cmp(r.key, ccy, 'costPerConsultCents', per(spend, n(P.consult_booked)), K.costPerConsultCents);
      cmp(r.key, ccy, 'costPerRoadmapCents', per(spend, n(P.roadmap_booked)), K.costPerRoadmapCents);
      cmp(r.key, ccy, 'revenue.collectedCents', n(B.collected), R.collectedCents);
      cmp(r.key, ccy, 'revenue.recurringCents', n(B.recurring_c), R.recurringCents);
      cmp(r.key, ccy, 'revenue.refundedCents', n(B.refunded_c), R.refundedCents);
      cmp(r.key, ccy, 'revenue.failedCount', n(B.failed_n), R.failedCount);
      cmp(r.key, ccy, 'revenue.excluded.count', n(B.excl_n), R.excluded.count);
      cmp(r.key, ccy, 'revenue.mrrCents', n(B.mrr), R.mrrCents);
      for (const t of ['Consult', 'Roadmap']) {
        const s = (S.show_rates ?? []).find((x: any) => x.type === t) ?? { past: 0, showed: 0, no_show: 0, cancelled: 0 };
        const a = A.showRates.find((x: any) => x.type === t) ?? { past: 0, showed: 0, noShow: 0, cancelled: 0, rate: null };
        const past = n(s.past);
        const coverage = past > 0 ? (n(s.showed) + n(s.no_show) + n(s.cancelled)) / past : null;
        const decided = n(s.showed) + n(s.no_show);
        cmp(r.key, ccy, `showRate.${t}.past`, past, a.past);
        cmp(r.key, ccy, `showRate.${t}.showed`, n(s.showed), a.showed);
        cmp(r.key, ccy, `showRate.${t}.noShow`, n(s.no_show), a.noShow);
        cmp(r.key, ccy, `showRate.${t}.rate (≥90% coverage)`, coverage !== null && coverage >= 0.9 && decided > 0 ? n(s.showed) / decided : null, a.rate);
      }
      cmp(r.key, ccy, 'campaigns.Σspend = spend', spend, A.campaigns.reduce((t: number, c: any) => t + c.spendCents, 0));
    }
    const sv = (engine[r.key] as any).served;
    cmp(r.key, sv.currency, 'served == direct (marketing)', JSON.stringify(byCcy[sv.currency].marketing), JSON.stringify(sv.marketing));
    cmp(r.key, '—', 'applicants without an application date', Number(S.applicants_without_date ?? 0), (sv.inputHealth?.applicantsWithoutDate ?? []).length);
    console.log(`engine ${r.key}: done`);
  }
  fs.writeFileSync(path.join(OUT, 'app-engine.json'), JSON.stringify(engine, null, 2));
  fs.writeFileSync(path.join(OUT, 'independent-sql.json'), JSON.stringify(indep, null, 2));
  fs.writeFileSync(path.join(OUT, 'compare.txt'), [`engine vs independent SQL — ${asOf.toISOString()}`, `${pass} PASS · ${fail} FAIL`, '', ...lines].join('\n') + '\n');
  check('Engine vs SQL', 'every metric × range × currency', fail === 0, `${pass} PASS · ${fail} FAIL (compare.txt)`);
  return { pass, fail };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. GHL: ghl_opportunities vs live, per opportunity and per stage × status. Read-only (ghlRequest, GET).
async function ghl(RANGES: Range[], tz: string, engineApplied: Record<string, number>) {
  const config = await getGhlConfig();
  if (!config.configured) {
    check('GHL', 'configured', false, 'GoHighLevel is not connected — nothing verified');
    return { error: 'not configured' };
  }
  const followed = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(and(eq(pipelines.isTracked, true), sql`${pipelines.archivedAt} is null`));
  const stageRows = await db.select({ id: stages.id, name: stages.name, pipelineId: stages.pipelineId }).from(stages).where(followed.length ? inArray(stages.pipelineId, followed.map((p) => p.id)) : sql`false`);
  const stageName = new Map(stageRows.map((s) => [s.id, s.name]));
  const localDay = (d: string | Date) => todayInTimezone(tz, new Date(d));
  const out: Record<string, unknown> = { followed };
  let missingAll = 0;
  let extraAll = 0;
  let stageAll = 0;
  let statusAll = 0;
  const liveCreated: string[] = [];
  for (const p of followed) {
    const live = await listAllOpportunities({ pipelineId: p.id, maxPages: 100 });
    if (live.error) {
      check('GHL', `live walk ${p.name}`, false, live.error);
      continue;
    }
    const L = new Map(live.opportunities.map((o) => [o.id, o]));
    const mirror = await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.pipelineId, p.id));
    const M = new Map(mirror.map((m) => [m.id, m]));
    const missing = [...L.keys()].filter((id) => !M.has(id));
    const extra = [...M.keys()].filter((id) => !L.has(id));
    const stageDiff = [...L.values()].filter((o) => M.has(o.id) && (M.get(o.id)!.stageId ?? null) !== (o.pipelineStageId ?? null)).map((o) => ({ opp: o.id, live: stageName.get(o.pipelineStageId ?? '') ?? o.pipelineStageId, mirror: stageName.get(M.get(o.id)!.stageId ?? '') ?? M.get(o.id)!.stageId }));
    const statusDiff = [...L.values()].filter((o) => M.has(o.id) && M.get(o.id)!.status !== o.status).map((o) => ({ opp: o.id, live: o.status, mirror: M.get(o.id)!.status }));
    missingAll += missing.length;
    extraAll += extra.length;
    stageAll += stageDiff.length;
    statusAll += statusDiff.length;
    for (const o of live.opportunities) if (o.createdAt) liveCreated.push(localDay(o.createdAt));

    // Per stage × status: live walk, the reconcile's own meta.total probe, and the mirror.
    const table: Array<{ stage: string; status: string; walk: number; probe: number | null; mirror: number }> = [];
    for (const s of stageRows.filter((x) => x.pipelineId === p.id)) {
      for (const status of OPPORTUNITY_STATUSES) {
        const walk = live.opportunities.filter((o) => o.pipelineStageId === s.id && o.status === status).length;
        const mir = mirror.filter((m) => m.stageId === s.id && m.status === status).length;
        const probe = await countOpportunities({ pipelineId: p.id, stageId: s.id, status });
        table.push({ stage: s.name, status, walk, probe: probe.total, mirror: mir });
        if (probe.total === null) check('GHL', `probe ${s.name} × ${status}`, false, probe.error ?? 'no meta.total');
      }
    }
    const diffs = table.filter((t) => t.walk !== t.mirror || (t.probe !== null && t.probe !== t.mirror));
    check('GHL', `${p.name}: ghl_opportunities = live per stage × status`, diffs.length === 0, diffs.length ? diffs.map((d) => `${d.stage}/${d.status} live ${d.walk} probe ${d.probe} mirror ${d.mirror}`).join('; ') : `${table.length} cells equal · ${live.opportunities.length} opportunities`);
    out[p.id] = { liveTotal: live.opportunities.length, mirrorTotal: mirror.length, missing, extra, stageDiff, statusDiff, table, requests: live.requests };
    console.log(`ghl ${p.name}: live ${live.opportunities.length} / mirror ${mirror.length}; missing ${missing.length}, extra ${extra.length}, stage ${stageDiff.length}, status ${statusDiff.length}`);
  }
  check('GHL', 'missing in mirror', missingAll === 0, String(missingAll));
  check('GHL', 'extra in mirror', extraAll === 0, String(extraAll));
  check('GHL', 'stage differs', stageAll === 0, String(stageAll));
  check('GHL', 'status differs', statusAll === 0, String(statusAll));
  // Applied (F14) = opportunities created in the range. The engine additionally excludes parked previous leads.
  const appliedByRange: Record<string, { liveCreated: number; engineApplied: number }> = {};
  for (const r of RANGES) appliedByRange[r.key] = { liveCreated: liveCreated.filter((d) => d >= r.start && d <= r.end).length, engineApplied: engineApplied[r.key] ?? 0 };
  out.appliedByRange = appliedByRange;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Stripe charges per range vs the payments mirror (GET via lib/stripe/client).
async function stripe(RANGES: Range[], tz: string) {
  const config = await getStripeConfig();
  if (!config.configured) {
    check('Stripe', 'configured', false, 'Stripe is not connected — nothing verified');
    return { error: 'not configured' };
  }
  const out: Record<string, unknown> = {};
  for (const r of RANGES) {
    const { start, end } = rangeToInstants(r, tz);
    const res = await listAll('/v1/charges', { created: { gte: Math.floor(start.getTime() / 1000), lte: Math.floor(end.getTime() / 1000) } }, 200);
    if (res.error) {
      check('Stripe', `${r.key}: list charges`, false, res.error);
      continue;
    }
    const live = new Map(
      (res.items as Array<{ id: string; status: string; currency: string; amount: number; amount_refunded: number }>).map((c) => [c.id, { status: c.status, currency: String(c.currency).toUpperCase(), amount: c.amount, refunded: c.amount_refunded }]),
    );
    const mirror = await rows<{ stripe_id: string; status: string; currency: string; amount_cents: number; refunded_cents: number }>(sql`
      select stripe_id, status, currency, amount_cents, refunded_cents from payments
      where stripe_id like 'ch_%' and kind in ('charge','invoice') and coalesce(stripe_created_at, paid_at, failed_at) between ${start.toISOString()} and ${end.toISOString()}`);
    const M = new Map(mirror.map((m) => [m.stripe_id, m]));
    const missing = [...live.keys()].filter((id) => !M.has(id));
    const differ = [...live.entries()]
      .filter(([id, l]) => {
        const m = M.get(id);
        return m && (Number(m.amount_cents) !== l.amount || Number(m.refunded_cents) !== l.refunded || m.currency !== l.currency || (l.status === 'succeeded' ? !['succeeded', 'refunded'].includes(m.status) : m.status !== l.status));
      })
      .map(([id, l]) => ({ id, live: l, mirror: M.get(id) }));
    out[r.key] = { live: live.size, mirror: mirror.length, missing, differ };
    check('Stripe', `${r.key}: missing = 0`, missing.length === 0, `${missing.length} of ${live.size} live charges`);
    check('Stripe', `${r.key}: differ = 0`, differ.length === 0, differ.length ? differ.slice(0, 5).map((d) => d.id).join(', ') : `${live.size} charges equal`);
    console.log(`stripe ${r.key}: live ${live.size} / mirror ${mirror.length}; missing ${missing.length}, differ ${differ.length}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Meta: the account's currency labels every stored row; account-level spend per day equals the mirror.
async function meta(RANGES: Range[]) {
  const config = await getMetaConfig();
  if (!config.configured) {
    check('Meta', 'configured', false, 'Meta is not connected — nothing verified');
    return { error: 'not configured' };
  }
  const acct = await fetchAccount();
  if (!acct.ok || !acct.data) {
    check('Meta', 'account read', false, acct.error ?? 'failed');
    return { error: acct.error };
  }
  const currency = acct.data.currency?.toUpperCase() ?? null;
  const labels = await rows<{ currency: string; n: string }>(sql`select currency, count(*)::text n from ad_spend where origin='meta' group by currency`);
  const wrong = labels.filter((l) => l.currency !== currency);
  check('Meta', 'stored currency = account currency', Boolean(currency) && wrong.length === 0, `account ${currency ?? 'unknown'} · rows ${labels.map((l) => `${l.currency} ${l.n}`).join(', ') || 'none'}`);
  const out: Record<string, unknown> = { account: { currency, timezone: acct.data.timezone_name ?? null } };
  for (const r of RANGES) {
    const live = await fetchAccountDailySpend({ since: r.start, until: r.end });
    if (live.error) {
      check('Meta', `${r.key}: account daily spend`, false, live.error);
      continue;
    }
    const L = new Map(live.rows.map((d) => [d.date_start, Math.round(Number(d.spend) * 100)]));
    const mirror = await rows<{ d: string; cents: string }>(sql`select to_char(date,'YYYY-MM-DD') d, sum(spend_cents)::text cents from ad_spend where platform='meta' and origin='meta' and date between ${r.start} and ${r.end} group by 1`);
    const M = new Map(mirror.map((x) => [x.d, Number(x.cents)]));
    const days = [...new Set([...L.keys(), ...M.keys()])].sort();
    const diffs = days.map((d) => ({ date: d, live: L.get(d) ?? 0, mirror: M.get(d) ?? 0 })).filter((x) => x.live !== x.mirror);
    out[r.key] = { liveTotal: [...L.values()].reduce((a, b) => a + b, 0), mirrorTotal: [...M.values()].reduce((a, b) => a + b, 0), diffs };
    check('Meta', `${r.key}: spend per day equal`, diffs.length === 0, diffs.length ? diffs.slice(0, 5).map((d) => `${d.date} live ${d.live} mirror ${d.mirror}`).join('; ') : `${days.length} days equal (${currency})`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. FX = Bank of Canada for its recent business days; no placeholder left where BoC covers.
async function fx() {
  const boc = await fetchBocRates({ recent: 10 });
  if (boc.error) {
    check('FX', 'Bank of Canada reachable', false, boc.error);
    return { error: boc.error };
  }
  const rates = [...boc.rates].sort((a, b) => a.date.localeCompare(b.date)); // Valet `recent` is newest first
  const dates = rates.map((r) => r.date);
  const stored = await db.select().from(fxRates).where(and(eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD'), inArray(fxRates.date, dates)));
  const S = new Map(stored.map((s) => [String(s.date), s]));
  const bad = rates.filter((r) => {
    const s = S.get(r.date);
    return !s || (s.source !== 'manual' && (s.source !== 'boc' || Math.abs(s.rate - r.rate) > 1e-6));
  });
  check('FX', 'stored USD→CAD = Bank of Canada (last 10 business days; manual overrides allowed)', bad.length === 0, bad.length ? bad.map((b) => `${b.date} BoC ${b.rate} stored ${S.get(b.date)?.rate ?? 'none'} (${S.get(b.date)?.source ?? '—'})`).join('; ') : `${dates[0]} – ${dates.at(-1)} equal · latest ${rates.at(-1)?.rate} (${dates.at(-1)})`);
  const [firstBoc] = await rows<{ d: string | null }>(sql`select min(date)::text d from fx_rates where source='boc'`);
  const seedsCovered = firstBoc?.d ? (await rows<{ n: string }>(sql`select count(*)::text n from fx_rates where source='seed' and date >= ${firstBoc.d}`))[0].n : '0';
  check('FX', 'no placeholder where BoC covers', Number(seedsCovered) === 0, `${seedsCovered} seed row(s) on/after ${firstBoc?.d ?? '—'}`);
  return { boc: rates, manual: stored.filter((s) => s.source === 'manual').map((s) => String(s.date)) };
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Markers = the last fetch; reconcile ok with 0 skipped.
const MARKER_KINDS: Record<MarkerFamily, string[] | null> = {
  'ghl.opportunities': ['ghl_delta', 'ghl_backfill'],
  'ghl.appointments': ['ghl_delta', 'ghl_backfill'],
  'ghl.mirrors': null, // weekly pass inside some GHL runs — no "later run" rule
  'meta.spend': ['meta_delta', 'meta_backfill'],
  'stripe.payments': ['stripe_delta', 'stripe_reconcile', 'stripe_backfill'],
  'stripe.completeness': ['stripe_completeness'],
  'fx.rates': ['fx_boc'],
  'applied.ledger': ['applied_ledger'],
  'applied.ratio': ['applied_ratio'],
};

async function health(ghlLiveTotal: number | null) {
  const out: Record<string, unknown> = {};
  for (const [family, kinds] of Object.entries(MARKER_KINDS) as Array<[MarkerFamily, string[] | null]>) {
    const m = await readMarker(family);
    if (!m) {
      check('Markers', family, false, 'no marker — this family has never completed a fetch');
      continue;
    }
    const at = new Date(m.completedAt);
    const [run] = m.runId ? await db.select().from(syncRuns).where(eq(syncRuns.id, m.runId)) : [];
    const inRun = run ? at.getTime() >= run.startedAt.getTime() - 1000 && at.getTime() <= (run.finishedAt ?? new Date()).getTime() + 60_000 : m.runId === null;
    const later = kinds ? await db.select({ id: syncRuns.id, kind: syncRuns.kind, finishedAt: syncRuns.finishedAt }).from(syncRuns).where(and(inArray(syncRuns.kind, kinds), eq(syncRuns.status, 'succeeded'), gt(syncRuns.finishedAt, new Date(at.getTime() + 60_000)))).orderBy(desc(syncRuns.finishedAt)).limit(1) : [];
    const ageH = (Date.now() - at.getTime()) / 3_600_000;
    let detail = `completed ${m.completedAt} (${ageH.toFixed(1)} h ago) · fetched ${m.fetched}${m.liveTotal != null ? ` of ${m.liveTotal}` : ''}${run ? ` · run ${run.kind} ${run.status}` : ''}`;
    let ok = inRun && later.length === 0;
    if (!inRun) detail += ' · completedAt is outside its run';
    if (later.length) detail += ` · a later ${later[0].kind} succeeded at ${later[0].finishedAt?.toISOString()} without moving the marker`;
    if (family === 'ghl.opportunities') {
      if (m.liveTotal != null && m.fetched !== m.liveTotal) {
        ok = false;
        detail += ' · fetched ≠ GHL total';
      }
      if (ghlLiveTotal !== null) detail += ` · live now ${ghlLiveTotal}`;
    }
    check('Markers', `${family} = last fetch`, ok, detail);
    out[family] = { marker: m, run: run ? { id: run.id, kind: run.kind, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt } : null };
  }
  const rec = await readReconcileSummary();
  check('Reconcile', 'ok with 0 skipped', Boolean(rec?.ok) && (rec?.skipped.length ?? 1) === 0, rec ? `at ${rec.at} · ${rec.checks} checks over ${rec.stagesChecked} stages · mismatches ${rec.mismatches.length} · skipped ${rec.skipped.length}` : 'never reconciled');
  out.reconcile = rec;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
function report(date: string, tz: string, RANGES: Range[], asOf: Date, OUT: string, extra: Record<string, unknown>) {
  const sections = [...new Set(checks.map((c) => c.section))];
  const passN = checks.filter((c) => c.ok).length;
  const failN = checks.length - passN;
  const md = [
    `# FitFlow verification — ${date}`,
    '',
    `Generated by \`npx tsx scripts/verify.ts\` at ${asOf.toISOString()} (business timezone ${tz}). Read-only: every provider call is a GET through the app's own clients; nothing was written.`,
    '',
    `**${failN === 0 ? 'ALL PASS' : `${failN} FAIL`}** — ${passN} of ${checks.length} checks passed. Raw outputs: \`docs/verification/${date}/\`.`,
    '',
    '## Ranges',
    '',
    ...RANGES.map((r) => `- **${r.key}** — ${r.label}: ${r.start} – ${r.end}`),
    '',
    ...sections.flatMap((s) => [`## ${s}`, '', '| | Check | Detail |', '|---|---|---|', ...checks.filter((c) => c.section === s).map((c) => `| ${c.ok ? 'PASS' : '**FAIL**'} | ${c.name} | ${c.detail.replace(/\|/g, '\\|')} |`), '']),
    '## Applied (F14): opportunities created in the followed pipeline vs the engine',
    '',
    '| Range | GHL created | Engine applied |',
    '|---|---|---|',
    ...Object.entries((extra.appliedByRange as Record<string, { liveCreated: number; engineApplied: number }>) ?? {}).map(([k, v]) => `| ${k} | ${v.liveCreated} | ${v.engineApplied} |`),
    '',
    'The engine excludes parked previous leads, so it can be lower than GHL by that count; any other gap is a finding.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(process.cwd(), 'docs', `verification-${date}.md`), md);
  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log(`\n${passN} PASS · ${failN} FAIL → docs/verification-${date}.md`);
  return failN;
}

// ---------------------------------------------------------------------------------------------------------------
// 7. Applied reconciliation ledger (docs/plan-reconciliation-2026-09-30.md): the ledger's current-definition count
//    for last week must equal the engine's applied (copied from the engine by construction — this guards the copy).
async function appliedLedgerCheck(RANGES: Range[], engineApplied: Record<string, number>) {
  const summary = await readAppliedSummary();
  if (!summary) {
    check('Applied ledger', 'reconciled', false, 'never ran — the dispatch step applied_ledger has not completed');
    return null;
  }
  const week = RANGES.find((r) => r.key === 'week');
  if (week) {
    const [row] = await rows<{ current: string; candidate: string; unresolved: string }>(sql`
      select count(*) filter (where verdict_current) ::text current,
             count(*) filter (where verdict_candidate) ::text candidate,
             count(*) filter (where verdict_current is null) ::text unresolved
      from applied_ledger where ledger_on between ${week.start}::date and ${week.end}::date`);
    const engine = engineApplied.week;
    const detail = `ledger current ${row.current} · candidate ${row.candidate} (deferred #1, not in use) · unresolved ${row.unresolved} · engine ${engine ?? 'not computed'} · ledger through ${summary.through}`;
    if (engine === undefined) check('Applied ledger', 'current = engine applied (last week)', false, `${detail} — run with the engine step to compare`);
    else check('Applied ledger', 'current = engine applied (last week)', Number(row.current) === engine, detail);
  }
  return summary;
}

async function main() {
  const what = process.argv[2] ?? 'all';
  const tz = await getTimezone(); // throws when not configured (F8) — never New York by default
  if (tz !== 'America/Edmonton' && !process.env.VERIFY_ALLOW_TZ) {
    console.error(`Business timezone resolved to ${tz}, not America/Edmonton — refusing (set VERIFY_ALLOW_TZ=1 to override).`);
    process.exit(2);
  }
  const asOf = new Date();
  const today = todayInTimezone(tz, asOf);
  const RANGES = rangesFor(today);
  const OUT = path.join(process.cwd(), 'docs', 'verification', today);
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`timezone ${tz} · today ${today} · ${RANGES.map((r) => `${r.key} ${r.start}–${r.end}`).join(' · ')}`);

  const engineApplied: Record<string, number> = {};
  if (what === 'all' || what === 'engine') {
    await engineVsSql(RANGES, tz, asOf, OUT);
    const eng = JSON.parse(fs.readFileSync(path.join(OUT, 'app-engine.json'), 'utf8'));
    for (const r of RANGES) engineApplied[r.key] = eng[r.key].byCcy.CAD.funnelPeriod.applied;
  }
  const extra: Record<string, unknown> = {};
  if (what === 'all' || what === 'sources') {
    const sources: Record<string, unknown> = { ranAt: asOf.toISOString(), timezone: tz };
    for (const [name, fn] of [
      ['ghl', () => ghl(RANGES, tz, engineApplied)],
      ['stripe', () => stripe(RANGES, tz)],
      ['meta', () => meta(RANGES)],
      ['fx', fx],
    ] as const) {
      try {
        sources[name] = await (fn as () => Promise<unknown>)();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        check(name.toUpperCase(), 'ran', false, msg);
        sources[name] = { error: msg };
      }
    }
    const ghlOut = sources.ghl as Record<string, any>;
    const liveTotal = ghlOut && !ghlOut.error ? Object.values(ghlOut).reduce((t: number, v: any) => t + (typeof v?.liveTotal === 'number' ? v.liveTotal : 0), 0) : null;
    sources.health = await health(liveTotal);
    sources.appliedLedger = await appliedLedgerCheck(RANGES, engineApplied);
    extra.appliedByRange = ghlOut?.appliedByRange ?? {};
    fs.writeFileSync(path.join(OUT, 'sources.json'), JSON.stringify(sources, null, 2));
  }
  const failN = report(today, tz, RANGES, asOf, OUT, extra);
  process.exit(failN === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
