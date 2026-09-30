/**
 * The Applied ledger job (plan item 2). Recomputed IN FULL every day from the mirror, since
 * `settings.backfill_from`: nothing is ever frozen, and a followed-pipeline toggle, a remap or a
 * contact re-fetch shows the next day.
 *
 *   1. `loadMetricsInput(backfill_from → today)` — the engine's own rows and facts.
 *   2. `verdict_current` = the contact is in `membershipFor(input, window, 'period').applied`:
 *      COPIED from the engine, never re-implemented (lib/reconcile/definitions.ts).
 *   3. `classifyApplication` over each counted (or parked) contact's held opportunity.
 *   4. One `ghl_opportunities` scan adds the rows the engine cannot count: S (a second opportunity
 *      of a contact), X / XN (unfollowed pipelines), unresolved (contact not mirrored yet).
 *   5. Upsert by key; delete keys the recompute no longer produces; summary + marker.
 *
 * Works: `stats.reason` = "since 2026-06-01 · 1,012 rows · A1 610 · … · unresolved 3 · sample 0 ·
 * mirror as of <ghl.mirrors>". Fails: `skipped` with the reason (no followed pipeline, no
 * ghl.opportunities marker) or `failed` + an error incident with the previous rows untouched.
 */

import { and, eq, gte, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { db, appliedLedger, contacts, ghlOpportunities, pipelines, stages, syncIncidents, syncRuns } from '@/db';
import { loadMetricsInput } from '../metrics/load';
import { membershipFor, normalizeCampaign, parkedIds, type MetricsInput } from '../metrics';
import { classifyApplication, type ApplicationClass, type ApplicationFacts } from './applied';
import { APPLIED_DEFINITIONS, LEDGER_VERSION } from './definitions';
import { getSetting, getTimezone, setSetting, SETTING_KEYS } from '../settings';
import { localDate, rangeToInstants, weekEnd, weekStart } from '../dates';
import { addDays, todayInTimezone } from '../day';
import { readMarker, writeMarker } from '../sync/markers';

export const APPLIED_SUMMARY_KEY = 'applied_reconcile_summary';

export interface LedgerRowInput {
  key: string;
  opportunityId: string | null;
  ghlContactId: string | null;
  contactId: string | null;
  name: string;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineFollowed: boolean;
  holdsPosition: boolean;
  firstRole: string | null;
  stageNow: string | null;
  contactSource: string | null;
  formSource: boolean;
  contactCreatedOn: string | null;
  contactCreatedEqualsOpportunity: boolean;
  opportunityCreatedOn: string | null;
  appliedOn: string | null;
  movedInOn: string | null;
  parked: boolean;
  alsoInFollowed: boolean;
  ledgerOn: string;
  utmCampaign: string | null;
  campaignKey: string | null;
  class: ApplicationClass;
  reason: string;
  verdictCurrent: boolean | null;
  verdictCandidate: boolean | null;
}

export interface ClassCount {
  count: number;
  /** "contact date unverified" A1 rows inside the count. */
  unverified?: number;
}

export interface WeekSummary {
  start: string;
  end: string;
  label: string;
  byClass: Record<ApplicationClass, ClassCount>;
  current: number;
  candidate: number;
  unresolved: number;
}

export interface AppliedLedgerSummary {
  ranAt: string;
  since: string;
  through: string;
  rows: number;
  byClass: Record<ApplicationClass, number>;
  lastWeek: WeekSummary;
  unresolved: number;
  sampleExcluded: number;
  followedPipelines: string[];
  ledgerVersion: string;
  mirrorAsOf: string | null;
  trackedAsOf: string | null;
  error?: string;
}

export interface LedgerRunResult {
  ok: boolean;
  runId: string | null;
  skipped?: string;
  summary: AppliedLedgerSummary | null;
  error?: string;
  reason?: string;
}

const emptyByClass = (): Record<ApplicationClass, number> => ({ A1: 0, A2: 0, U: 0, A3: 0, C: 0, D: 0, M: 0, P: 0, S: 0, X: 0, XN: 0, unresolved: 0 });

/**
 * PURE: the ledger rows for the engine's contacts (one per held opportunity) plus the extra
 * opportunities the scan found. Exported for the parity tests.
 */
export function buildLedgerRows(params: {
  input: MetricsInput;
  window: { start: string; end: string };
  followed: Map<string, string>;
  /** Every opportunity created / moved into the window, with its contact when mirrored. */
  scanned: Array<{ id: string; ghlContactId: string; pipelineId: string; pipelineName: string | null; stageName: string | null; createdOn: string | null; contact: { id: string; name: string; source: string | null; createdOn: string | null; pipelineId: string | null; heldOpportunityId: string | null; utmCampaign: string | null; origin: string } | null }>;
}): { rows: LedgerRowInput[]; sampleExcluded: number } {
  const { input, window, followed } = params;
  const counted = new Set(membershipFor(input, window, 'period').applied); // ← the engine, never re-implemented
  const parked = parkedIds(input);
  const rows = new Map<string, LedgerRowInput>();
  let sampleExcluded = 0;

  const push = (r: LedgerRowInput) => rows.set(r.key, r);

  for (const c of input.contacts) {
    if (c.origin === 'demo') {
      sampleExcluded += 1;
      continue;
    }
    const facts: ApplicationFacts = {
      pipelineFollowed: true,
      holdsPosition: true,
      contactMirrored: true,
      source: c.source,
      contactCreatedOn: c.contactCreatedOn ?? null,
      opportunityCreatedOn: c.opportunityCreatedOn ?? null,
      firstStageRole: c.firstStageRole ?? null,
      movedInOn: c.movedInOn ?? null,
      parked: parked.has(c.id),
      contactCreatedEqualsOpportunity: c.contactCreatedEqualsOpportunity,
    };
    const cls = classifyApplication(facts);
    const isCounted = counted.has(c.id);
    const ledgerOn = (isCounted ? c.appliedOn : null) ?? c.movedInOn ?? c.opportunityCreatedOn ?? c.appliedOn ?? null;
    if (!ledgerOn || ledgerOn < window.start || ledgerOn > window.end) continue; // outside the window
    push({
      key: c.ghlOpportunityId ?? `contact:${c.id}`,
      opportunityId: c.ghlOpportunityId ?? null,
      ghlContactId: c.ghlContactId ?? null,
      contactId: c.id,
      name: c.name,
      pipelineId: c.pipelineId ?? null,
      pipelineName: c.pipelineId ? (followed.get(c.pipelineId) ?? null) : null,
      pipelineFollowed: true,
      holdsPosition: true,
      firstRole: c.firstStageRole ?? null,
      stageNow: c.stageName,
      contactSource: c.source,
      formSource: cls.formSource,
      contactCreatedOn: c.contactCreatedOn ?? null,
      contactCreatedEqualsOpportunity: Boolean(c.contactCreatedEqualsOpportunity),
      opportunityCreatedOn: c.opportunityCreatedOn ?? null,
      appliedOn: isCounted ? c.appliedOn : null,
      movedInOn: c.movedInOn ?? null,
      parked: parked.has(c.id),
      alsoInFollowed: false,
      ledgerOn,
      utmCampaign: c.campaign ?? null,
      campaignKey: c.campaign ? normalizeCampaign(c.campaign) : null,
      class: cls.class,
      reason: cls.reason,
      verdictCurrent: isCounted,
      verdictCandidate: APPLIED_DEFINITIONS.candidate.counts(cls.class),
    });
  }

  // The rows the engine cannot count.
  const contactRowById = new Map(input.contacts.map((c) => [c.id, c]));
  for (const o of params.scanned) {
    if (rows.has(o.id)) continue;
    if (o.contact?.origin === 'demo') continue;
    const pipelineFollowed = followed.has(o.pipelineId);
    const mirrored = o.contact !== null;
    const held = o.contact?.heldOpportunityId === o.id;
    const inInput = o.contact ? contactRowById.get(o.contact.id) : undefined;
    const facts: ApplicationFacts = {
      pipelineFollowed,
      holdsPosition: held,
      contactMirrored: mirrored,
      source: o.contact?.source ?? null,
      contactCreatedOn: o.contact?.createdOn ?? null,
      opportunityCreatedOn: o.createdOn,
      firstStageRole: null,
      movedInOn: null,
      parked: inInput ? parked.has(inInput.id) : false,
    };
    const cls = classifyApplication(facts);
    const ledgerOn = o.createdOn;
    if (!ledgerOn || ledgerOn < window.start || ledgerOn > window.end) continue;
    const alsoInFollowed = Boolean(o.contact?.pipelineId && followed.has(o.contact.pipelineId));
    push({
      key: o.id,
      opportunityId: o.id,
      ghlContactId: o.ghlContactId,
      contactId: o.contact?.id ?? null,
      name: o.contact?.name ?? 'Unknown (contact not mirrored)',
      pipelineId: o.pipelineId,
      pipelineName: o.pipelineName,
      pipelineFollowed,
      holdsPosition: held,
      firstRole: null,
      stageNow: o.stageName,
      contactSource: o.contact?.source ?? null,
      formSource: cls.formSource,
      contactCreatedOn: o.contact?.createdOn ?? null,
      contactCreatedEqualsOpportunity: false,
      opportunityCreatedOn: o.createdOn,
      appliedOn: null,
      movedInOn: null,
      parked: facts.parked,
      alsoInFollowed,
      ledgerOn,
      utmCampaign: o.contact?.utmCampaign ?? null,
      campaignKey: o.contact?.utmCampaign ? normalizeCampaign(o.contact.utmCampaign) : null,
      class: cls.class,
      reason: cls.reason,
      verdictCurrent: cls.class === 'unresolved' ? null : false,
      verdictCandidate: cls.class === 'unresolved' ? null : APPLIED_DEFINITIONS.candidate.counts(cls.class),
    });
  }

  // The candidate counts a PERSON once per day: an X row yields to a followed candidate row on the same day.
  const followedCandidateDays = new Set<string>();
  for (const r of rows.values()) if (r.pipelineFollowed && r.verdictCandidate) followedCandidateDays.add(`${r.ghlContactId ?? r.contactId}|${r.ledgerOn}`);
  for (const r of rows.values()) if (r.class === 'X' && followedCandidateDays.has(`${r.ghlContactId ?? r.contactId}|${r.ledgerOn}`)) r.verdictCandidate = false;

  return { rows: [...rows.values()], sampleExcluded };
}

/** PURE: per-class counts and both verdicts for one range of ledger days. */
export function summarizeWeek(rows: LedgerRowInput[], week: { start: string; end: string; label: string }): WeekSummary {
  const byClass = Object.fromEntries((Object.keys(emptyByClass()) as ApplicationClass[]).map((k) => [k, { count: 0 } as ClassCount])) as Record<ApplicationClass, ClassCount>;
  let current = 0;
  let candidate = 0;
  let unresolved = 0;
  for (const r of rows) {
    if (r.ledgerOn < week.start || r.ledgerOn > week.end) continue;
    byClass[r.class].count += 1;
    if (r.class === 'A1' && r.contactCreatedEqualsOpportunity) byClass.A1.unverified = (byClass.A1.unverified ?? 0) + 1;
    if (r.verdictCurrent) current += 1;
    if (r.verdictCandidate) candidate += 1;
    if (r.verdictCurrent === null) unresolved += 1;
  }
  return { ...week, byClass, current, candidate, unresolved };
}

export function lastCompleteWeek(today: string): { start: string; end: string; label: string } {
  const start = weekStart(addDays(weekStart(today), -1));
  const end = weekEnd(start);
  return { start, end, label: `${start} – ${end}` };
}

export async function readAppliedSummary(): Promise<AppliedLedgerSummary | null> {
  const raw = await getSetting(APPLIED_SUMMARY_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppliedLedgerSummary;
  } catch {
    return null;
  }
}

/** The dispatch gate + the once-per-day rule. */
export async function appliedLedgerSkipReason(opts: { force?: boolean; today: string; timezone: string }): Promise<string | null> {
  const followed = await db.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)));
  if (followed.length === 0) return 'no followed pipeline';
  const tracked = await readMarker('ghl.opportunities');
  if (!tracked) return 'waiting for the first complete read of the followed pipeline (no ghl.opportunities marker yet)';
  if (!opts.force) {
    // Once per local day: the summary records the day it was computed THROUGH (deterministic; the marker gives the time).
    const [summary, marker] = await Promise.all([readAppliedSummary(), readMarker('applied.ledger')]);
    if (summary && summary.through === opts.today && marker) return `already ran today at ${new Date(marker.completedAt).toLocaleTimeString('en-GB', { timeZone: opts.timezone, hour: '2-digit', minute: '2-digit', hour12: false })}`;
  }
  return null;
}

export async function runAppliedLedger(options: { trigger: 'cron' | 'manual' | 'cli'; force?: boolean; today?: string }): Promise<LedgerRunResult> {
  const startedAt = new Date();
  const timezone = await getTimezone();
  const today = options.today ?? todayInTimezone(timezone);
  const skip = await appliedLedgerSkipReason({ force: options.force, today, timezone });
  if (skip) return { ok: true, runId: null, summary: await readAppliedSummary(), skipped: skip };

  const [run] = await db.insert(syncRuns).values({ kind: 'applied_ledger', trigger: options.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });
  try {
    const since = (await getSetting(SETTING_KEYS.backfillFrom)) ?? '2026-06-01';
    const window = { start: since, end: today };
    const followedRows = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)));
    const followed = new Map(followedRows.map((p) => [p.id, p.name]));
    const input = await loadMetricsInput({ start: since, end: today, timezone });

    // Every opportunity created in the window (any pipeline), with its contact when mirrored.
    const { start, end } = rangeToInstants(window, timezone);
    const scannedRows = await db
      .select({
        id: ghlOpportunities.id,
        ghlContactId: ghlOpportunities.ghlContactId,
        pipelineId: ghlOpportunities.pipelineId,
        pipelineName: pipelines.name,
        stageName: stages.name,
        createdAt: ghlOpportunities.ghlCreatedAt,
        contactId: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        source: contacts.attributionSource,
        contactCreatedAt: contacts.ghlCreatedAt,
        contactPipelineId: contacts.pipelineId,
        heldOpportunityId: contacts.ghlOpportunityId,
        utmCampaign: contacts.utmCampaign,
        origin: contacts.origin,
      })
      .from(ghlOpportunities)
      .leftJoin(contacts, eq(contacts.ghlContactId, ghlOpportunities.ghlContactId))
      .leftJoin(pipelines, eq(pipelines.id, ghlOpportunities.pipelineId))
      .leftJoin(stages, eq(stages.id, ghlOpportunities.stageId))
      .where(and(gte(ghlOpportunities.ghlCreatedAt, start), lte(ghlOpportunities.ghlCreatedAt, end)));
    const scanned = scannedRows.map((r) => ({
      id: r.id,
      ghlContactId: r.ghlContactId,
      pipelineId: r.pipelineId,
      pipelineName: r.pipelineName,
      stageName: r.stageName,
      createdOn: r.createdAt ? localDate(r.createdAt, timezone) : null,
      contact: r.contactId
        ? { id: r.contactId, name: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.email || 'Unknown', source: r.source, createdOn: r.contactCreatedAt ? localDate(r.contactCreatedAt, timezone) : null, pipelineId: r.contactPipelineId, heldOpportunityId: r.heldOpportunityId, utmCampaign: r.utmCampaign, origin: r.origin ?? 'ghl' }
        : null,
    }));

    const { rows, sampleExcluded } = buildLedgerRows({ input, window, followed, scanned });

    // Upsert in batches; delete keys the recompute no longer produces (the mirror dropped them).
    const computedAt = new Date();
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((r) => ({ ...r, ledgerVersion: LEDGER_VERSION, computedAt }));
      await db
        .insert(appliedLedger)
        .values(batch)
        .onConflictDoUpdate({
          target: appliedLedger.key,
          set: Object.fromEntries((Object.keys(batch[0]) as Array<keyof (typeof batch)[number]>).filter((k) => k !== 'key').map((k) => [k, sql.raw(`excluded."${(appliedLedger as unknown as Record<string, { name: string }>)[k].name}"`)])),
        });
    }
    const keys = rows.map((r) => r.key);
    if (keys.length) await db.delete(appliedLedger).where(notInArray(appliedLedger.key, keys));
    else await db.delete(appliedLedger);

    const byClass = emptyByClass();
    for (const r of rows) byClass[r.class] += 1;
    const [mirrors, tracked] = await Promise.all([readMarker('ghl.mirrors'), readMarker('ghl.opportunities')]);
    const summary: AppliedLedgerSummary = {
      ranAt: startedAt.toISOString(),
      since,
      through: today,
      rows: rows.length,
      byClass,
      lastWeek: summarizeWeek(rows, lastCompleteWeek(today)),
      unresolved: byClass.unresolved,
      sampleExcluded,
      followedPipelines: [...followed.values()],
      ledgerVersion: LEDGER_VERSION,
      mirrorAsOf: mirrors?.completedAt ?? null,
      trackedAsOf: tracked?.completedAt ?? null,
    };
    await setSetting(APPLIED_SUMMARY_KEY, JSON.stringify(summary));
    await writeMarker({ family: 'applied.ledger', runId: run.id, fetched: rows.length, detail: `since ${since} · ${rows.length} rows` });
    const classes = (Object.keys(byClass) as ApplicationClass[]).filter((k) => byClass[k] > 0).map((k) => `${k} ${byClass[k]}`).join(' · ');
    const reason = `since ${since} · ${rows.length.toLocaleString('en-US')} rows · ${classes || 'no rows'}${byClass.unresolved ? '' : ' · unresolved 0'} · sample ${sampleExcluded} · mirror as of ${mirrors?.completedAt ?? 'never'}`;
    await db.update(syncRuns).set({ status: 'succeeded', finishedAt: new Date(), stats: { rows: rows.length, unresolved: byClass.unresolved, sampleExcluded, reason } }).where(eq(syncRuns.id, run.id));
    return { ok: true, runId: run.id, summary, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(syncRuns).set({ status: 'failed', finishedAt: new Date(), error: message, stats: { reason: message } }).where(eq(syncRuns.id, run.id));
    await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Applied ledger failed: ${message}` });
    const previous = await readAppliedSummary();
    return { ok: false, runId: run.id, summary: previous ? { ...previous, error: message } : null, error: message };
  }
}

/** The dispatch step. */
export async function runAppliedLedgerStep(opts: { force?: boolean } = {}): Promise<LedgerRunResult | { skipped: string }> {
  const r = await runAppliedLedger({ trigger: 'cron', force: opts.force });
  if (r.skipped) return { skipped: r.skipped };
  return r;
}

