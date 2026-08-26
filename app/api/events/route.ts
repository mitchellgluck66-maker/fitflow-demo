import { NextResponse } from 'next/server';
import { db, stageTransitions, contacts, stages, syncRuns } from '@/db';
import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events — the audit trail, now derived rather than marked:
 * every stage move observed by a sync plus every sync run, newest first.
 * Shape kept compatible with the Audit page.
 */
export async function GET() {
  try {
    const fromStage = alias(stages, 'from_stage');
    const toStage = alias(stages, 'to_stage');

    const moves = await db
      .select({
        id: stageTransitions.id,
        contactId: stageTransitions.contactId,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        fromName: fromStage.name,
        toName: toStage.name,
        fromRole: stageTransitions.fromRole,
        toRole: stageTransitions.toRole,
        kind: stageTransitions.kind,
        observedAt: stageTransitions.observedAt,
        previousObservedAt: stageTransitions.previousObservedAt,
        origin: stageTransitions.origin,
        backfilled: stageTransitions.backfilled,
      })
      .from(stageTransitions)
      .innerJoin(contacts, eq(stageTransitions.contactId, contacts.id))
      .leftJoin(fromStage, eq(stageTransitions.fromStageId, fromStage.id))
      .leftJoin(toStage, eq(stageTransitions.toStageId, toStage.id))
      .orderBy(desc(stageTransitions.observedAt))
      .limit(500);

    const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(100);

    const events = [
      ...moves.map((m) => ({
        id: m.id,
        leadId: m.contactId,
        leadName: `${m.firstName} ${m.lastName}`.trim(),
        action: m.kind === 'diff' ? 'StageMoved' : m.kind === 'backfill' ? 'Backfilled' : 'FirstSeen',
        priorStage: m.fromName,
        newStage: m.toName,
        priorRole: m.fromRole,
        newRole: m.toRole,
        appointmentStatus: null as string | null,
        actor: m.origin === 'demo' ? 'sample data' : 'GoHighLevel sync',
        notes:
          m.kind === 'diff' && m.previousObservedAt
            ? `Observed between ${m.previousObservedAt.toISOString()} and ${m.observedAt.toISOString()}`
            : null,
        syncStatus: m.origin === 'demo' ? 'demo' : m.backfilled ? 'backfilled' : 'synced',
        createdAt: m.observedAt.toISOString(),
      })),
      ...runs.map((r) => ({
        id: r.id,
        leadId: '',
        leadName: undefined as string | undefined,
        action: 'GhlSyncRun',
        priorStage: null,
        newStage: null,
        priorRole: null,
        newRole: null,
        appointmentStatus: null as string | null,
        actor: r.trigger,
        notes: r.error
          ? `${r.kind} failed: ${r.error}`
          : `${r.kind}: ${Object.entries(r.stats)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || 'no changes'}`,
        syncStatus: r.status === 'succeeded' ? 'synced' : r.status === 'failed' ? 'failed' : 'syncing',
        createdAt: r.startedAt.toISOString(),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return NextResponse.json(events);
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}
