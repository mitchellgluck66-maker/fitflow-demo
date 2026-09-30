/**
 * "Applied" reconciliation for one Sun–Sat week (READ-ONLY, 2026-09-30, Mitchell's investigation).
 *
 *   set -a; source .env.local; set +a; npx tsx scripts/reconcile-applied.ts 2026-09-20 [2026-09-26]
 *
 * Pulls, through the app's own GET-only clients:
 *   1. GHL form submissions for the week (needs the `forms.readonly` scope on the token);
 *   2. GHL opportunities created in the week across EVERY pipeline (one location-wide walk);
 *   3. what FitFlow counted as applied for the week (the engine, period mode);
 *   4. Meta's submit-application actions per campaign, on both report-time bases and both
 *      attribution windows, with `unique_actions` beside `actions`.
 * Writes docs/verification/applied-reconciliation-<start>.json with every row it used; the markdown
 * report is written by hand from that JSON. Nothing is written to any database or external system.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db, contacts, pipelines, stages, stageTransitions, ghlOpportunities } from '../db';
import { getTimezone } from '../lib/settings';
import { ghlRequest, listAllOpportunities, listPipelines, getContact } from '../lib/ghl/client';
import { getGhlConfig } from '../lib/ghl/config';
import { metaRequest } from '../lib/meta/client';
import { getMetaConfig } from '../lib/meta/config';
import { getScorecard } from '../lib/metrics/service';
import { localDate } from '../lib/dates';

const start = process.argv[2] ?? '2026-09-20';
const end = process.argv[3] ?? '2026-09-26';
const OUT = path.join(process.cwd(), 'docs', 'verification', `applied-reconciliation-${start}.json`);
const out: Record<string, unknown> = { start, end, ranAt: new Date().toISOString(), notVerified: [] as string[] };
const notVerified = out.notVerified as string[];

const inWeek = (iso: string | null | undefined, tz: string): boolean => {
  if (!iso) return false;
  const d = localDate(new Date(iso), tz);
  return d >= start && d <= end;
};

// ---------------------------------------------------------------------------------------------
// 1. Forms + submissions
async function forms(tz: string, locationId: string) {
  const list = await ghlRequest({ method: 'GET', endpoint: '/forms/', family: 'contacts', query: { locationId, limit: 100 } });
  if (!list.ok) {
    notVerified.push(`GHL forms: ${list.error}`);
    return { error: list.error };
  }
  const all = ((list.data as { forms?: Array<{ id: string; name: string }> })?.forms ?? []).map((f) => ({ id: f.id, name: f.name }));
  const submissions: Array<Record<string, unknown>> = [];
  // A day either side, then filter by the business-local date of each submission.
  const startAt = new Date(new Date(`${start}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const endAt = new Date(new Date(`${end}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  for (let page = 1; page <= 50; page += 1) {
    const r = await ghlRequest({ method: 'GET', endpoint: '/forms/submissions', family: 'contacts', query: { locationId, startAt, endAt, limit: 100, page } });
    if (!r.ok) {
      notVerified.push(`GHL form submissions page ${page}: ${r.error}`);
      break;
    }
    const d = r.data as { submissions?: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
    submissions.push(...(d.submissions ?? []));
    const total = Number((d.meta as { total?: unknown } | undefined)?.total ?? NaN);
    if ((d.submissions ?? []).length < 100 || (Number.isFinite(total) && submissions.length >= total)) break;
  }
  const rows = submissions
    .map((s) => ({
      id: String(s.id ?? ''),
      formId: String(s.formId ?? ''),
      formName: all.find((f) => f.id === String(s.formId ?? ''))?.name ?? String(s.formId ?? ''),
      contactId: String(s.contactId ?? ''),
      createdAt: String(s.createdAt ?? ''),
      localDate: s.createdAt ? localDate(new Date(String(s.createdAt)), tz) : null,
      name: String(s.name ?? ''),
      email: String(s.email ?? ''),
    }))
    .filter((s) => inWeek(s.createdAt, tz));
  const byForm = new Map<string, { submissions: number; people: Set<string> }>();
  for (const s of rows) {
    const b = byForm.get(s.formName) ?? { submissions: 0, people: new Set<string>() };
    b.submissions += 1;
    b.people.add(s.contactId || s.email);
    byForm.set(s.formName, b);
  }
  return { forms: all, submissions: rows, byForm: Object.fromEntries(Array.from(byForm.entries()).map(([k, v]) => [k, { submissions: v.submissions, people: v.people.size }])) };
}

// ---------------------------------------------------------------------------------------------
// 2. Opportunities created in the week, every pipeline
async function opportunities(tz: string) {
  const pl = await listPipelines();
  if (!pl.ok || !pl.data) throw new Error(`pipelines: ${pl.error}`);
  const pipelineName = new Map(pl.data.pipelines.map((p) => [p.id, p.name]));
  const stageName = new Map<string, string>();
  for (const p of pl.data.pipelines) for (const s of p.stages ?? []) stageName.set(s.id, s.name);
  const walk = await listAllOpportunities({ maxPages: 200 });
  if (walk.error) notVerified.push(`GHL opportunity walk stopped: ${walk.error}`);
  const created = walk.opportunities
    .filter((o) => inWeek(o.createdAt, tz))
    .map((o) => ({
      id: o.id,
      contactId: o.contactId,
      contactName: o.contact?.name ?? o.name,
      pipelineId: o.pipelineId,
      pipeline: pipelineName.get(o.pipelineId) ?? o.pipelineId,
      stageId: o.pipelineStageId,
      stage: stageName.get(o.pipelineStageId) ?? o.pipelineStageId,
      status: o.status,
      source: o.source ?? null,
      createdAt: o.createdAt,
      localDate: localDate(new Date(o.createdAt!), tz),
      lastStageChangeAt: o.lastStageChangeAt ?? null,
    }));
  return { walked: walk.opportunities.length, requests: walk.requests, created, pipelines: pl.data.pipelines.map((p) => ({ id: p.id, name: p.name })) };
}

// ---------------------------------------------------------------------------------------------
// 4. Meta submit-application conversions per campaign. Runtime evidence (2026-09-30): Ads Manager's "Website
// Submit Applications" column is the `conversions` field's `submit_application_website` action, NOT anything in
// `actions` (the pixel's custom events aggregate there as `offsite_conversion.fb_pixel_custom`).
const Conv = z.object({ action_type: z.string(), value: z.union([z.string(), z.number()]), '7d_click': z.union([z.string(), z.number()]).nullish(), '1d_view': z.union([z.string(), z.number()]).nullish(), '1d_click': z.union([z.string(), z.number()]).nullish() });
const RowSchema = z.object({
  campaign_id: z.string().nullish(),
  campaign_name: z.string().nullish(),
  date_start: z.string().nullish(),
  conversions: z.array(Conv).nullish(),
  unique_conversions: z.array(Conv).nullish(),
});
const PageSchema = z.object({ data: z.array(RowSchema), paging: z.object({ next: z.string().nullish() }).nullish() });

async function meta() {
  const cfg = await getMetaConfig();
  if (!cfg.configured) {
    notVerified.push('Meta: not configured');
    return { error: 'not configured' };
  }
  const pick = (list: Array<z.infer<typeof Conv>> | null | undefined) =>
    (list ?? [])
      .filter((a) => a.action_type === 'submit_application_website')
      .map((a) => ({ value: Number(a.value), click7d: a['7d_click'] == null ? null : Number(a['7d_click']), view1d: a['1d_view'] == null ? null : Number(a['1d_view']), click1d: a['1d_click'] == null ? null : Number(a['1d_click']) }))[0] ?? null;
  const results: Record<string, unknown> = {};
  for (const reportTime of ['conversion', 'impression'] as const) {
    for (const windows of [['7d_click', '1d_view'], ['7d_click'], ['1d_click']]) {
      const r = await metaRequest(
        `/${cfg.adAccountId}/insights`,
        { level: 'campaign', fields: 'campaign_id,campaign_name,conversions,unique_conversions', time_range: JSON.stringify({ since: start, until: end }), action_report_time: reportTime, action_attribution_windows: JSON.stringify(windows), limit: 200 },
        PageSchema,
      );
      const key = `${reportTime}:${windows.join('+')}`;
      if (!r.ok || !r.data) {
        notVerified.push(`Meta insights (${key}): ${r.error}`);
        continue;
      }
      results[key] = r.data.data.map((row) => ({ campaign: row.campaign_name, id: row.campaign_id, submitApplication: pick(row.conversions), unique: pick(row.unique_conversions) }));
    }
  }
  // Per day, conversion time vs impression time — the date basis behind the 82.
  for (const reportTime of ['conversion', 'impression'] as const) {
    const r = await metaRequest(
      `/${cfg.adAccountId}/insights`,
      { level: 'campaign', fields: 'campaign_name,conversions', time_range: JSON.stringify({ since: start, until: end }), time_increment: 1, action_report_time: reportTime, action_attribution_windows: JSON.stringify(['7d_click', '1d_view']), limit: 500 },
      PageSchema,
    );
    if (!r.ok || !r.data) {
      notVerified.push(`Meta daily (${reportTime}): ${r.error}`);
      continue;
    }
    results[`daily:${reportTime}`] = r.data.data.map((row) => ({ date: row.date_start, campaign: row.campaign_name, submitApplication: pick(row.conversions)?.value ?? 0 }));
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const tz = await getTimezone();
  if (tz !== 'America/Edmonton') throw new Error(`timezone resolved to ${tz}`);
  const ghl = await getGhlConfig();
  if (!ghl.configured || !ghl.locationId) throw new Error('GHL not configured');
  out.timezone = tz;

  console.log('1. forms…');
  out.forms = await forms(tz, ghl.locationId);
  console.log('2. opportunities (location-wide walk)…');
  const opps = await opportunities(tz);
  out.opportunities = opps;
  console.log(`   walked ${opps.walked} opportunities in ${opps.requests} requests; ${opps.created.length} created ${start}–${end}`);

  console.log('3. FitFlow…');
  const sc = await getScorecard({ range: 'week', start, end, compare: 'off' });
  const applied = sc.scorecard.funnel.stages.find((s) => s.key === 'applied')!;
  const appliedRows = applied.contactIds.length ? await db.select({ id: contacts.id, ghlContactId: contacts.ghlContactId, opp: contacts.ghlOpportunityId, utm: contacts.utmCampaign, first: contacts.firstName, last: contacts.lastName, pipelineId: contacts.pipelineId }).from(contacts).where(inArray(contacts.id, applied.contactIds)) : [];
  const followed = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(eq(pipelines.isTracked, true));
  out.fitflow = { range: sc.range, applied: applied.count, followed, rows: appliedRows, health: sc.inputHealth ?? null };

  // 3b. Per person: everyone who created an opportunity this week (any pipeline) or submitted a form.
  const oppByContact = new Map<string, typeof opps.created>();
  for (const o of opps.created) oppByContact.set(o.contactId, [...(oppByContact.get(o.contactId) ?? []), o]);
  const subs = ((out.forms as { submissions?: Array<{ contactId: string; formName: string; createdAt: string }> }).submissions ?? []);
  const subByContact = new Map<string, typeof subs>();
  for (const s of subs) subByContact.set(s.contactId, [...(subByContact.get(s.contactId) ?? []), s]);
  const countedByGhl = new Map(appliedRows.map((r) => [r.ghlContactId, r]));
  const people = Array.from(new Set([...oppByContact.keys(), ...subByContact.keys()]));

  // The stage each opportunity was FIRST seen in (FitFlow's transition history), to spot manual entries into later stages.
  const oppIds = opps.created.map((o) => o.id);
  const firstSeen = new Map<string, { stage: string | null; role: string | null; at: Date }>();
  if (oppIds.length) {
    const tr = await db
      .select({ opp: stageTransitions.ghlOpportunityId, toStageId: stageTransitions.toStageId, toRole: stageTransitions.toRole, at: stageTransitions.observedAt })
      .from(stageTransitions)
      .where(inArray(stageTransitions.ghlOpportunityId, oppIds))
      .orderBy(stageTransitions.observedAt);
    const sn = new Map((await db.select({ id: stages.id, name: stages.name, role: stages.semanticRole }).from(stages)).map((s) => [s.id, s]));
    for (const t of tr) if (t.opp && !firstSeen.has(t.opp)) firstSeen.set(t.opp, { stage: t.toStageId ? (sn.get(t.toStageId)?.name ?? t.toStageId) : null, role: t.toStageId ? (sn.get(t.toStageId)?.role ?? t.toRole) : t.toRole, at: t.at });
    const mirror = await db.select({ id: ghlOpportunities.id, created: ghlOpportunities.ghlCreatedAt }).from(ghlOpportunities).where(inArray(ghlOpportunities.id, oppIds));
    out.mirrorHas = mirror.length;
  }

  // Contact details (creation date, utm) for everyone — one GET per person (deduped; ≤ ~100).
  const contactInfo = new Map<string, { created: string | null; utmCampaign: string | null; utmSource: string | null; source: string | null; tags: string[] }>();
  for (const id of people) {
    const c = await getContact(id);
    const k = c.data?.contact as unknown as Record<string, unknown> | undefined;
    if (!c.ok || !k) {
      notVerified.push(`contact ${id}: ${c.error}`);
      continue;
    }
    const attr = (k.attributionSource as Record<string, unknown> | null) ?? null;
    contactInfo.set(id, {
      created: (k.dateAdded as string | undefined) ?? null,
      utmCampaign: (attr?.utmCampaign as string | undefined) ?? null,
      utmSource: (attr?.utmSource as string | undefined) ?? null,
      source: (k.source as string | undefined) ?? null,
      tags: (k.tags as string[] | undefined) ?? [],
    });
  }

  const followedIds = new Set(followed.map((f) => f.id));
  const table = people.map((id) => {
    const os = oppByContact.get(id) ?? [];
    const ss = subByContact.get(id) ?? [];
    const counted = countedByGhl.get(id) ?? null;
    const info = contactInfo.get(id);
    const inFollowed = os.find((o) => followedIds.has(o.pipelineId));
    const first = inFollowed ? firstSeen.get(inFollowed.id) : undefined;
    let reason = '';
    if (counted) reason = 'counted';
    else if (!os.length) reason = 'form submitted, no opportunity created this week';
    else if (!inFollowed) reason = `opportunity only in "${os[0].pipeline}" (not followed)`;
    else if (inFollowed.status !== 'open' && !first) reason = `opportunity ${inFollowed.status}`;
    else reason = 'in followed pipeline but not counted — see mirror';
    return {
      contactId: id,
      name: os[0]?.contactName ?? (ss[0] as { name?: string } | undefined)?.name ?? counted?.first ?? '',
      contactCreated: info?.created ?? null,
      contactCreatedThisWeek: info?.created ? inWeek(info.created, tz) : null,
      utmCampaign: info?.utmCampaign ?? counted?.utm ?? null,
      contactSource: info?.source ?? null,
      forms: ss.map((s) => `${s.formName} @ ${s.createdAt}`),
      opportunities: os.map((o) => `${o.pipeline} / ${o.stage} (${o.status}) @ ${o.createdAt}${o.source ? ` · src ${o.source}` : ''}`),
      firstSeenStage: first ? `${first.stage} [${first.role}]` : null,
      createdIntoLaterStage: first ? !['applied', 'unmapped', null, 'other'].includes(first.role ?? null) : null,
      countedByFitFlow: Boolean(counted),
      reason,
    };
  });
  out.people = table;

  console.log('4. Meta…');
  out.meta = await meta();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT}`);
  console.log('people', table.length, 'counted', table.filter((p) => p.countedByFitFlow).length, 'not verified:', notVerified.length ? notVerified : 'none');
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
