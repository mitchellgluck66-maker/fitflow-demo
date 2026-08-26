/**
 * Row loader for the metrics engine. This is the ONLY place the engine's
 * inputs touch the database. It fetches everything needed for a window (the
 * selected range, its comparison range and the trailing baseline), converts
 * instants to business-local calendar dates, and hands plain rows to the pure
 * functions in ./index.ts.
 */

import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { db, contacts, stages, pipelines, stageTransitions, appointments, adSpend, payments } from '@/db';
import { localDate, rangeToInstants } from '../dates';
import type { MetricsInput } from './index';

export interface LoadOptions {
  /** Widest calendar window needed (YYYY-MM-DD, inclusive). */
  start: string;
  end: string;
  timezone: string;
  /** Restrict to one pipeline; undefined = every tracked pipeline. */
  pipelineId?: string;
}

export async function loadMetricsInput(opts: LoadOptions): Promise<MetricsInput> {
  const { start, end } = rangeToInstants({ start: opts.start, end: opts.end }, opts.timezone);
  const tz = opts.timezone;

  // Tracked pipelines (or the one requested).
  const tracked = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(
      opts.pipelineId
        ? eq(pipelines.id, opts.pipelineId)
        : and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)),
    );
  const pipelineIds = tracked.map((p) => p.id);

  // Contacts: every contact in a tracked pipeline (or with no pipeline yet —
  // a brand-new applicant may not have an opportunity for a few minutes).
  const contactRows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      source: contacts.attributionSource,
      stageId: contacts.stageId,
      stageName: stages.name,
      role: stages.semanticRole,
      pipelineId: contacts.pipelineId,
      ghlCreatedAt: contacts.ghlCreatedAt,
      createdAt: contacts.createdAt,
      monetaryValueCents: contacts.monetaryValueCents,
      origin: contacts.origin,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .where(
      pipelineIds.length
        ? or(inArray(contacts.pipelineId, pipelineIds), isNull(contacts.pipelineId))
        : isNull(contacts.pipelineId),
    );
  const contactIds = contactRows.map((c) => c.id);

  const transitionRows = contactIds.length
    ? await db
        .select({
          contactId: stageTransitions.contactId,
          fromRole: stageTransitions.fromRole,
          toRole: stageTransitions.toRole,
          toStageId: stageTransitions.toStageId,
          observedAt: stageTransitions.observedAt,
        })
        .from(stageTransitions)
        .where(inArray(stageTransitions.contactId, contactIds))
    : [];

  // Appointments: the whole window plus a tail on either side so to-do
  // buckets ("no later booking") and show rates see the full picture.
  const apptRows = await db
    .select({
      contactId: appointments.contactId,
      type: appointments.type,
      outcome: appointments.outcome,
      startTime: appointments.startTime,
    })
    .from(appointments)
    .where(and(gte(appointments.startTime, new Date(start.getTime() - 120 * 86_400_000)), lte(appointments.startTime, new Date(end.getTime() + 120 * 86_400_000))));

  const spendRows = await db
    .select({ date: adSpend.date, platform: adSpend.platform, spendCents: adSpend.spendCents, origin: adSpend.origin })
    .from(adSpend)
    .where(and(gte(adSpend.date, opts.start), lte(adSpend.date, opts.end)));

  const paymentRows = await db
    .select({
      contactId: payments.contactId,
      amountCents: payments.amountCents,
      refundedCents: payments.refundedCents,
      status: payments.status,
      paidAt: payments.paidAt,
      origin: payments.origin,
    })
    .from(payments);

  return {
    contacts: contactRows.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim() || c.email || 'Unknown',
      email: c.email,
      source: c.source,
      stageId: c.stageId,
      stageName: c.stageName ?? null,
      role: c.role ?? null,
      appliedOn: localDate(c.ghlCreatedAt ?? c.createdAt, tz),
      monetaryValueCents: c.monetaryValueCents ?? 0,
      origin: c.origin,
    })),
    transitions: transitionRows.map((t) => ({
      contactId: t.contactId,
      fromRole: t.fromRole ?? null,
      toRole: t.toRole ?? null,
      toStageId: t.toStageId,
      on: localDate(t.observedAt, tz),
      atMs: t.observedAt.getTime(),
    })),
    appointments: apptRows.map((a) => ({
      contactId: a.contactId,
      type: a.type,
      outcome: a.outcome,
      on: localDate(a.startTime, tz),
      atMs: a.startTime.getTime(),
    })),
    spend: spendRows.map((s) => ({ date: s.date, platform: s.platform, spendCents: s.spendCents, origin: s.origin })),
    payments: paymentRows.map((p) => ({
      contactId: p.contactId,
      amountCents: p.amountCents,
      refundedCents: p.refundedCents,
      status: p.status,
      on: p.paidAt ? localDate(p.paidAt, tz) : null,
      origin: p.origin,
    })),
  };
}
