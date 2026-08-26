/**
 * Sync engine: drains the GHL outbox.
 *
 * Marking an outcome in the UI writes rows to `ghl_sync_queue` rather than
 * calling GHL inline. That gives us three things a direct call cannot:
 *
 *   - Staff can correct a mis-click before midnight without a compensating write
 *     having already gone out.
 *   - A GHL outage or expired token doesn't block the person doing their job.
 *   - Every attempt is recorded, so a failed sync is visible instead of silent.
 *
 * The queue is drained by the midnight job, or on demand from the Today View.
 */

import { db, appointments, ghlSyncQueue, leadEvents, leads } from '@/db';
import { and, asc, eq, inArray, lte, or, isNull } from 'drizzle-orm';
import { ghlRequest, type GhlRequest } from './client';
import { getGhlConfig, type GhlApiFamily } from './config';

const MAX_ATTEMPTS = 4;

/** Endpoint prefix -> which API version header the call needs. */
function familyForEndpoint(endpoint: string): GhlApiFamily {
  if (endpoint.startsWith('/calendars')) return 'calendars';
  if (endpoint.startsWith('/opportunities')) return 'opportunities';
  if (endpoint.startsWith('/contacts')) return 'contacts';
  if (endpoint.startsWith('/users')) return 'users';
  return 'locations';
}

export interface SyncRunResult {
  dryRun: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  appointmentsSynced: number;
  details: Array<{
    id: string;
    operation: string;
    endpoint: string;
    status: 'succeeded' | 'failed' | 'dry_run';
    error?: string;
    payload?: unknown;
  }>;
}

/**
 * Process pending queue items.
 *
 * Items are drained in (appointment, sequence) order so the authoritative
 * appointment-status write always lands before the dependent stage move. If an
 * item fails permanently, later items for the SAME appointment are held back -
 * moving a pipeline stage when the attendance write failed would leave GHL in a
 * state that contradicts itself.
 */
export async function runSync(options: { limit?: number } = {}): Promise<SyncRunResult> {
  const config = await getGhlConfig();
  const limit = options.limit ?? 500;

  const pending = await db
    .select()
    .from(ghlSyncQueue)
    .where(
      or(
        eq(ghlSyncQueue.status, 'pending'),
        and(eq(ghlSyncQueue.status, 'failed'), lte(ghlSyncQueue.attempts, MAX_ATTEMPTS)),
      ),
    )
    .orderBy(asc(ghlSyncQueue.appointmentId), asc(ghlSyncQueue.sequence))
    .limit(limit);

  const result: SyncRunResult = {
    dryRun: config.dryRun,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    appointmentsSynced: 0,
    details: [],
  };

  // Appointments whose authoritative write failed this run - their dependent
  // operations are deferred rather than applied against a bad base state.
  const blockedAppointments = new Set<string>();
  const touchedAppointments = new Set<string>();

  for (const item of pending) {
    if (item.appointmentId && blockedAppointments.has(item.appointmentId)) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;
    const now = new Date().toISOString();

    const request: GhlRequest = {
      method: item.method as GhlRequest['method'],
      endpoint: item.endpoint,
      family: familyForEndpoint(item.endpoint),
      body: JSON.parse(item.payload) as Record<string, unknown>,
    };

    const response = await ghlRequest(request);

    if (response.dryRun) {
      await db
        .update(ghlSyncQueue)
        .set({
          status: 'dry_run',
          attempts: item.attempts + 1,
          processedAt: now,
          responseBody: JSON.stringify({
            note: 'DRY RUN - not sent',
            wouldSend: { method: request.method, endpoint: request.endpoint, body: request.body },
          }),
        })
        .where(eq(ghlSyncQueue.id, item.id));

      result.succeeded += 1;
      result.details.push({
        id: item.id,
        operation: item.operation,
        endpoint: item.endpoint,
        status: 'dry_run',
        payload: request.body,
      });
      if (item.appointmentId) touchedAppointments.add(item.appointmentId);
      continue;
    }

    if (response.ok) {
      await db
        .update(ghlSyncQueue)
        .set({
          status: 'succeeded',
          attempts: item.attempts + 1,
          processedAt: now,
          lastError: null,
          responseBody: JSON.stringify(response.data).slice(0, 2000),
        })
        .where(eq(ghlSyncQueue.id, item.id));

      result.succeeded += 1;
      result.details.push({
        id: item.id,
        operation: item.operation,
        endpoint: item.endpoint,
        status: 'succeeded',
      });
      if (item.appointmentId) touchedAppointments.add(item.appointmentId);
    } else {
      await db
        .update(ghlSyncQueue)
        .set({
          status: 'failed',
          attempts: item.attempts + 1,
          processedAt: now,
          lastError: response.error?.slice(0, 1000) ?? 'Unknown error',
        })
        .where(eq(ghlSyncQueue.id, item.id));

      result.failed += 1;
      result.details.push({
        id: item.id,
        operation: item.operation,
        endpoint: item.endpoint,
        status: 'failed',
        error: response.error,
      });

      // A failed authoritative write blocks everything downstream for this
      // appointment until the next run.
      if (item.sequence === 0 && item.appointmentId) {
        blockedAppointments.add(item.appointmentId);
      }
    }
  }

  // Mark appointments fully synced only when nothing is left outstanding.
  for (const appointmentId of touchedAppointments) {
    if (blockedAppointments.has(appointmentId)) continue;

    const outstanding = await db
      .select({ id: ghlSyncQueue.id })
      .from(ghlSyncQueue)
      .where(
        and(
          eq(ghlSyncQueue.appointmentId, appointmentId),
          inArray(ghlSyncQueue.status, ['pending', 'failed', 'in_flight']),
        ),
      );

    if (outstanding.length === 0) {
      await db
        .update(appointments)
        .set({
          syncStatus: config.dryRun ? 'pending' : 'synced',
          syncedAt: config.dryRun ? null : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(appointments.id, appointmentId));

      result.appointmentsSynced += 1;
    }
  }

  // Record the run itself in the audit trail.
  await recordSyncRun(result);

  return result;
}

/** Write a summary of the run into lead_events so it shows in the Audit Log. */
async function recordSyncRun(result: SyncRunResult): Promise<void> {
  if (result.processed === 0) return;

  const anyLead = await db.select({ id: leads.id }).from(leads).limit(1);
  if (anyLead.length === 0) return;

  await db.insert(leadEvents).values({
    leadId: anyLead[0].id,
    action: 'GhlSyncRun',
    actor: 'system',
    notes: result.dryRun
      ? `Dry run: ${result.processed} operations previewed, ${result.appointmentsSynced} appointments ready`
      : `Synced ${result.succeeded}/${result.processed} operations to GoHighLevel (${result.failed} failed)`,
    metadata: JSON.stringify({
      dryRun: result.dryRun,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
    }),
    syncStatus: result.dryRun ? 'local' : result.failed > 0 ? 'failed' : 'synced',
  });
}

/** Counts for the sync status badge in the UI. */
export async function getQueueStats(): Promise<{
  pending: number;
  failed: number;
  succeeded: number;
  dryRun: number;
  configured: boolean;
  isDryRun: boolean;
}> {
  const config = await getGhlConfig();
  const all = await db.select({ status: ghlSyncQueue.status }).from(ghlSyncQueue);

  const count = (s: string) => all.filter((r) => r.status === s).length;

  return {
    pending: count('pending'),
    failed: count('failed'),
    succeeded: count('succeeded'),
    dryRun: count('dry_run'),
    configured: config.configured,
    isDryRun: config.dryRun,
  };
}
