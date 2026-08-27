/**
 * Read-only client profile + index queries (GHL parity).
 *
 * Everything here is OBSERVED data — stage transitions from sync diffs,
 * appointments and outcomes mirrored from GHL, payments from Stripe. Nothing
 * is editable in FitFlow.
 */

import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, contacts, stages, pipelines, stageTransitions, appointments, payments } from '@/db';
import type { SemanticRole } from '@/db/schema';
import { getGhlConfig } from '../ghl/config';

export type TimelineTone = 'positive' | 'negative' | 'neutral';

export interface TimelineItem {
  id: string;
  at: string;
  type: 'transition' | 'appointment' | 'payment';
  title: string;
  detail: string | null;
  tone: TimelineTone;
  backfilled: boolean;
  meta?: Record<string, unknown>;
}

export interface ClientProfile {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  entryFunnel: string | null;
  owner: string | null;
  tags: string[];
  ghlContactId: string;
  ghlOpportunityId: string | null;
  /** Deep link into the GHL app, null when the location id is unknown or the row is demo. */
  ghlUrl: string | null;
  origin: string;
  pipelineName: string | null;
  stageName: string | null;
  stageRole: SemanticRole | null;
  /** Hours in the current stage (since the latest transition into it, else since applied). */
  timeInStageHours: number | null;
  stageEnteredAt: string | null;
  opportunityStatus: string | null;
  monetaryValueCents: number;
  appliedAt: string | null;
  lastActivityAt: string | null;
  timeline: TimelineItem[];
}

const NEGATIVE_ROLES: ReadonlySet<string> = new Set(['consult_noshow']);

function roleTone(role: string | null | undefined, stageName?: string | null): TimelineTone {
  if (role === 'enrolled') return 'positive';
  if (role && NEGATIVE_ROLES.has(role)) return 'negative';
  if (stageName && /no.?show|lost|objection/i.test(stageName)) return 'negative';
  return 'neutral';
}

export function buildGhlUrl(locationId: string | null, ghlContactId: string, origin: string): string | null {
  if (!locationId || origin === 'demo') return null;
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${ghlContactId}`;
}

export async function getClientProfile(id: string): Promise<ClientProfile | null> {
  const [row] = await db
    .select({
      c: contacts,
      stageName: stages.name,
      stageRole: stages.semanticRole,
      pipelineName: pipelines.name,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .leftJoin(pipelines, eq(contacts.pipelineId, pipelines.id))
    .where(eq(contacts.id, id))
    .limit(1);
  if (!row) return null;
  const c = row.c;

  const fromStage = alias(stages, 'from_stage');
  const toStage = alias(stages, 'to_stage');
  const [transitions, appts, pays, config] = await Promise.all([
    db
      .select({
        id: stageTransitions.id,
        fromName: fromStage.name,
        toName: toStage.name,
        fromRole: stageTransitions.fromRole,
        toRole: stageTransitions.toRole,
        toStageId: stageTransitions.toStageId,
        observedAt: stageTransitions.observedAt,
        previousObservedAt: stageTransitions.previousObservedAt,
        kind: stageTransitions.kind,
        backfilled: stageTransitions.backfilled,
      })
      .from(stageTransitions)
      .leftJoin(fromStage, eq(stageTransitions.fromStageId, fromStage.id))
      .leftJoin(toStage, eq(stageTransitions.toStageId, toStage.id))
      .where(eq(stageTransitions.contactId, id))
      .orderBy(desc(stageTransitions.observedAt)),
    db.select().from(appointments).where(eq(appointments.contactId, id)).orderBy(desc(appointments.startTime)),
    db.select().from(payments).where(eq(payments.contactId, id)).orderBy(desc(payments.createdAt)),
    getGhlConfig(),
  ]);

  const timeline: TimelineItem[] = [];

  for (const t of transitions) {
    const to = t.toName ?? 'Unknown stage';
    timeline.push({
      id: t.id,
      at: t.observedAt.toISOString(),
      type: 'transition',
      title: t.fromName ? `${t.fromName} → ${to}` : `Entered ${to}`,
      detail:
        t.kind === 'diff' && t.previousObservedAt
          ? `Observed between ${t.previousObservedAt.toISOString()} and ${t.observedAt.toISOString()}`
          : t.kind === 'backfill'
            ? 'Imported by backfill'
            : 'First seen by sync',
      tone: roleTone(t.toRole, to),
      backfilled: t.backfilled,
      meta: { fromRole: t.fromRole, toRole: t.toRole, kind: t.kind },
    });
  }

  for (const a of appts) {
    const outcome = a.outcome === 'showed' ? 'Showed' : a.outcome === 'no_show' ? 'No-show' : a.outcome === 'cancelled' ? 'Cancelled' : a.startTime > new Date() ? 'Upcoming' : 'Not recorded';
    timeline.push({
      id: a.id,
      at: a.startTime.toISOString(),
      type: 'appointment',
      title: `${a.type} · ${outcome}`,
      detail: [a.title, a.assignedTo ? `with ${a.assignedTo}` : null, `GHL status: ${a.ghlStatus}`].filter(Boolean).join(' · '),
      tone: a.outcome === 'showed' ? 'positive' : a.outcome === 'no_show' || a.outcome === 'cancelled' ? 'negative' : 'neutral',
      backfilled: a.backfilled,
      meta: { type: a.type, outcome: a.outcome, ghlStatus: a.ghlStatus },
    });
  }

  for (const p of pays) {
    const at = p.paidAt ?? p.failedAt ?? p.createdAt;
    const amount = (p.amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: p.currency || 'USD' });
    const kind = p.kind === 'subscription' ? 'Subscription' : p.kind === 'invoice' ? 'Invoice payment' : p.kind === 'refund' ? 'Refund' : 'Payment';
    timeline.push({
      id: p.id,
      at: at.toISOString(),
      type: 'payment',
      title: `${kind} ${amount} · ${p.status}`,
      detail: [p.description, p.refundedCents > 0 ? `refunded ${(p.refundedCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` : null, p.matchSource ? `matched ${p.matchSource}` : null]
        .filter(Boolean)
        .join(' · ') || null,
      tone: p.status === 'succeeded' || p.status === 'active' ? 'positive' : p.status === 'failed' || p.status === 'refunded' || p.kind === 'refund' ? 'negative' : 'neutral',
      backfilled: p.backfilled,
      meta: { kind: p.kind, status: p.status, amountCents: p.amountCents },
    });
  }

  timeline.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const enteredCurrent = transitions.find((t) => t.toStageId === c.stageId) ?? null;
  const stageEnteredAt = enteredCurrent?.observedAt ?? c.lastStageChangeAt ?? c.ghlCreatedAt ?? null;
  const appliedAt = c.ghlCreatedAt ?? c.createdAt;

  return {
    id: c.id,
    name: `${c.firstName} ${c.lastName}`.trim() || c.email || 'Unknown',
    email: c.email,
    phone: c.phone,
    source: c.attributionSource,
    utmSource: c.utmSource,
    utmMedium: c.utmMedium,
    utmCampaign: c.utmCampaign,
    utmContent: c.utmContent,
    entryFunnel: c.entryFunnel,
    owner: c.ownerName,
    tags: c.tags ?? [],
    ghlContactId: c.ghlContactId,
    ghlOpportunityId: c.ghlOpportunityId,
    ghlUrl: buildGhlUrl(config.locationId, c.ghlContactId, c.origin),
    origin: c.origin,
    pipelineName: row.pipelineName ?? null,
    stageName: row.stageName ?? null,
    stageRole: row.stageRole ?? null,
    timeInStageHours: stageEnteredAt ? Math.round(((Date.now() - stageEnteredAt.getTime()) / 3_600_000) * 10) / 10 : null,
    stageEnteredAt: stageEnteredAt?.toISOString() ?? null,
    opportunityStatus: c.opportunityStatus,
    monetaryValueCents: c.monetaryValueCents ?? 0,
    appliedAt: appliedAt.toISOString(),
    lastActivityAt: timeline[0]?.at ?? null,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface ClientListRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  stageId: string | null;
  stageName: string | null;
  stageRole: SemanticRole | null;
  appliedAt: string;
  lastActivityAt: string | null;
  owner: string | null;
  origin: string;
}

export interface ClientListParams {
  q?: string | null;
  stageId?: string | null;
  source?: string | null;
  /** Applied date range, YYYY-MM-DD inclusive. */
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
  sort?: 'applied_desc' | 'applied_asc' | 'name_asc' | 'activity_desc';
}

export interface ClientListResult {
  rows: ClientListRow[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    stages: Array<{ id: string; name: string; role: SemanticRole | null; count: number }>;
    sources: Array<{ source: string; count: number }>;
  };
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export async function listClients(params: ClientListParams = {}): Promise<ClientListResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const q = params.q?.trim() ?? '';

  const conditions = [];
  if (q.length > 0) {
    const pattern = `%${q}%`;
    const phoneDigits = digits(q);
    conditions.push(
      or(
        ilike(contacts.email, pattern),
        ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, pattern),
        ...(phoneDigits.length >= 4 ? [ilike(contacts.phoneNormalized, `%${phoneDigits}%`)] : []),
      ),
    );
  }
  if (params.stageId) conditions.push(eq(contacts.stageId, params.stageId));
  if (params.source) conditions.push(eq(contacts.attributionSource, params.source));
  if (params.from) conditions.push(gte(sql`coalesce(${contacts.ghlCreatedAt}, ${contacts.createdAt})`, new Date(`${params.from}T00:00:00Z`)));
  if (params.to) conditions.push(lte(sql`coalesce(${contacts.ghlCreatedAt}, ${contacts.createdAt})`, new Date(`${params.to}T23:59:59.999Z`)));
  const where = conditions.length ? and(...conditions) : undefined;

  const appliedExpr = sql`coalesce(${contacts.ghlCreatedAt}, ${contacts.createdAt})`;
  const orderBy =
    params.sort === 'applied_asc'
      ? [asc(appliedExpr)]
      : params.sort === 'name_asc'
        ? [asc(contacts.firstName), asc(contacts.lastName)]
        : [desc(appliedExpr)];

  const [rows, [{ total }], stageFacets, sourceFacets] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        source: contacts.attributionSource,
        stageId: contacts.stageId,
        stageName: stages.name,
        stageRole: stages.semanticRole,
        ghlCreatedAt: contacts.ghlCreatedAt,
        createdAt: contacts.createdAt,
        ghlUpdatedAt: contacts.ghlUpdatedAt,
        lastStageChangeAt: contacts.lastStageChangeAt,
        owner: contacts.ownerName,
        origin: contacts.origin,
      })
      .from(contacts)
      .leftJoin(stages, eq(contacts.stageId, stages.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(where),
    db
      .select({ id: stages.id, name: stages.name, role: stages.semanticRole, count: sql<number>`count(${contacts.id})::int` })
      .from(stages)
      .leftJoin(contacts, eq(contacts.stageId, stages.id))
      .groupBy(stages.id, stages.name, stages.semanticRole, stages.position)
      .orderBy(asc(stages.position)),
    db
      .select({ source: contacts.attributionSource, count: sql<number>`count(*)::int` })
      .from(contacts)
      .groupBy(contacts.attributionSource)
      .orderBy(desc(sql`count(*)`)),
  ]);

  // Last activity: newest of the latest transition / appointment / payment per listed contact.
  const ids = rows.map((r) => r.id);
  const lastActivity = new Map<string, Date>();
  if (ids.length) {
    const bump = (id: string | null, d: Date | null) => {
      if (!id || !d) return;
      const prev = lastActivity.get(id);
      if (!prev || d > prev) lastActivity.set(id, d);
    };
    const [t, a, p] = await Promise.all([
      db
        .select({ id: stageTransitions.contactId, at: sql<Date>`max(${stageTransitions.observedAt})` })
        .from(stageTransitions)
        .where(inArray(stageTransitions.contactId, ids))
        .groupBy(stageTransitions.contactId),
      db
        .select({ id: appointments.contactId, at: sql<Date>`max(${appointments.startTime})` })
        .from(appointments)
        .where(inArray(appointments.contactId, ids))
        .groupBy(appointments.contactId),
      db
        .select({ id: payments.contactId, at: sql<Date>`max(coalesce(${payments.paidAt}, ${payments.failedAt}, ${payments.createdAt}))` })
        .from(payments)
        .where(inArray(payments.contactId, ids))
        .groupBy(payments.contactId),
    ]);
    for (const list of [t, a, p]) for (const r of list) bump(r.id, r.at ? new Date(r.at) : null);
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim() || r.email || 'Unknown',
      email: r.email,
      phone: r.phone,
      source: r.source,
      stageId: r.stageId,
      stageName: r.stageName ?? null,
      stageRole: r.stageRole ?? null,
      appliedAt: (r.ghlCreatedAt ?? r.createdAt).toISOString(),
      lastActivityAt: lastActivity.get(r.id)?.toISOString() ?? null,
      owner: r.owner,
      origin: r.origin,
    })),
    total,
    limit,
    offset,
    facets: {
      stages: stageFacets.map((s) => ({ id: s.id, name: s.name, role: s.role ?? null, count: s.count })),
      sources: sourceFacets.map((s) => ({ source: s.source ?? 'Unknown', count: s.count })),
    },
  };
}
