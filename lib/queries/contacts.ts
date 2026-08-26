/**
 * Read helpers over contacts/stages used by the existing v1 screens while the
 * v2 Command Center is built (Phase B). These keep the old "lead" JSON shape
 * so the pages keep working against the new schema.
 */

import { db, contacts, stages, pipelines, appointments } from '@/db';
import { asc, desc, eq, gte, isNull, and } from 'drizzle-orm';

export interface LeadView {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  stage: string;
  stageId: string | null;
  semanticRole: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  source: string | null;
  utmCampaign: string | null;
  owner: string | null;
  estimatedValue: number;
  opportunityStatus: string | null;
  appointmentTime: string | null;
  createdAt: string;
  dateApplied: string | null;
  origin: string;
  tags: string[];
}

export interface StageView {
  id: string;
  pipelineId: string;
  pipelineName: string;
  name: string;
  position: number;
  semanticRole: string | null;
  roleSource: string;
  roleConfidence: number | null;
  suggestedRole: string | null;
  archived: boolean;
  origin: string;
}

export async function listStages(): Promise<StageView[]> {
  const rows = await db
    .select({
      id: stages.id,
      pipelineId: stages.pipelineId,
      pipelineName: pipelines.name,
      pipelinePosition: pipelines.position,
      name: stages.name,
      position: stages.position,
      semanticRole: stages.semanticRole,
      roleSource: stages.roleSource,
      roleConfidence: stages.roleConfidence,
      suggestedRole: stages.suggestedRole,
      archivedAt: stages.archivedAt,
      origin: stages.origin,
    })
    .from(stages)
    .innerJoin(pipelines, eq(stages.pipelineId, pipelines.id))
    .orderBy(asc(pipelines.position), asc(stages.position));

  return rows.map((r) => ({
    id: r.id,
    pipelineId: r.pipelineId,
    pipelineName: r.pipelineName,
    name: r.name,
    position: r.position ?? 0,
    semanticRole: r.semanticRole,
    roleSource: r.roleSource,
    roleConfidence: r.roleConfidence,
    suggestedRole: r.suggestedRole,
    archived: r.archivedAt !== null,
    origin: r.origin,
  }));
}

export async function listContactsAsLeads(): Promise<LeadView[]> {
  const rows = await db
    .select({
      c: contacts,
      stageName: stages.name,
      semanticRole: stages.semanticRole,
      pipelineName: pipelines.name,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .leftJoin(pipelines, eq(contacts.pipelineId, pipelines.id))
    .orderBy(desc(contacts.ghlCreatedAt), desc(contacts.createdAt));

  // Next upcoming appointment per contact (one query, not N).
  const upcoming = await db
    .select({ contactId: appointments.contactId, startTime: appointments.startTime })
    .from(appointments)
    .where(and(gte(appointments.startTime, new Date()), isNull(appointments.outcome)))
    .orderBy(asc(appointments.startTime));
  const nextByContact = new Map<string, Date>();
  for (const a of upcoming) {
    if (a.contactId && !nextByContact.has(a.contactId)) nextByContact.set(a.contactId, a.startTime);
  }

  return rows.map(({ c, stageName, semanticRole, pipelineName }) => ({
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email ?? '',
    phone: c.phone,
    stage: stageName ?? 'Unassigned',
    stageId: c.stageId,
    semanticRole: semanticRole ?? null,
    pipelineId: c.pipelineId,
    pipelineName: pipelineName ?? null,
    source: c.attributionSource,
    utmCampaign: c.utmCampaign,
    owner: c.ownerName,
    estimatedValue: c.monetaryValueCents ?? 0,
    opportunityStatus: c.opportunityStatus,
    appointmentTime: nextByContact.get(c.id)?.toISOString() ?? null,
    createdAt: (c.ghlCreatedAt ?? c.createdAt).toISOString(),
    dateApplied: c.ghlCreatedAt?.toISOString() ?? null,
    origin: c.origin,
    tags: c.tags ?? [],
  }));
}
