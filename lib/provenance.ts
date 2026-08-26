/**
 * Where the data on screen came from (CLAUDE.md rule 6).
 * The sample-data banner reads this; the Setup page's reset button uses it.
 */

import { db, contacts, appointments, stageTransitions, adSpend, pipelines, stages, syncRuns } from '@/db';
import { desc, eq, sql } from 'drizzle-orm';

export interface Provenance {
  demoContacts: number;
  ghlContacts: number;
  manualContacts: number;
  demoAppointments: number;
  ghlAppointments: number;
  hasDemoData: boolean;
  hasRealData: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  // Legacy names kept for the existing banner/UI.
  demoLeads: number;
  ghlLeads: number;
  manualLeads: number;
}

async function countBy(table: typeof contacts | typeof appointments, origin: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.origin, origin));
  return row?.n ?? 0;
}

export async function getDataProvenance(): Promise<Provenance> {
  const [demoContacts, ghlContacts, manualContacts, demoAppointments, ghlAppointments] = await Promise.all([
    countBy(contacts, 'demo'),
    countBy(contacts, 'ghl'),
    countBy(contacts, 'manual'),
    countBy(appointments, 'demo'),
    countBy(appointments, 'ghl'),
  ]);

  const [last] = await db
    .select({ startedAt: syncRuns.startedAt, status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.kind, 'ghl_delta'))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  return {
    demoContacts,
    ghlContacts,
    manualContacts,
    demoAppointments,
    ghlAppointments,
    hasDemoData: demoContacts > 0 || demoAppointments > 0,
    hasRealData: ghlContacts > 0 || manualContacts > 0,
    lastSyncAt: last?.startedAt?.toISOString() ?? null,
    lastSyncStatus: last?.status ?? null,
    demoLeads: demoContacts,
    ghlLeads: ghlContacts,
    manualLeads: manualContacts,
  };
}

/** Remove every fabricated row. Real (ghl/manual) rows are never touched. */
export async function clearDemoData(): Promise<{
  contactsRemoved: number;
  appointmentsRemoved: number;
  transitionsRemoved: number;
}> {
  const t = await db.delete(stageTransitions).where(eq(stageTransitions.origin, 'demo')).returning({ id: stageTransitions.id });
  const a = await db.delete(appointments).where(eq(appointments.origin, 'demo')).returning({ id: appointments.id });
  const c = await db.delete(contacts).where(eq(contacts.origin, 'demo')).returning({ id: contacts.id });
  await db.delete(adSpend).where(eq(adSpend.origin, 'demo'));
  await db.delete(stages).where(eq(stages.origin, 'demo'));
  await db.delete(pipelines).where(eq(pipelines.origin, 'demo'));
  return { contactsRemoved: c.length, appointmentsRemoved: a.length, transitionsRemoved: t.length };
}
