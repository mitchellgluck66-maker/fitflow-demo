/**
 * DORMANT — legacy GHL write-back outbox drainer.
 *
 * FitFlow v2 never writes to GoHighLevel (CLAUDE.md rule 1). This module is
 * kept only so the history of how write-back worked is not lost. It is gated
 * twice: `runSync` returns immediately unless ENABLE_WRITEBACK is true, and
 * even if it were, `ghlRequest` itself throws on any non-GET request while
 * the flag is off. Nothing in the app calls this module except
 * `getQueueStats` (for the legacy Settings badge, always empty).
 */

import { db, ghlSyncQueue } from '@/db';
import { and, asc, eq, lte, or } from 'drizzle-orm';
import { ghlRequest, type GhlRequest } from './client';
import { ENABLE_WRITEBACK, type GhlApiFamily } from './config';

const MAX_ATTEMPTS = 4;

function familyForEndpoint(endpoint: string): GhlApiFamily {
  if (endpoint.startsWith('/calendars')) return 'calendars';
  if (endpoint.startsWith('/opportunities')) return 'opportunities';
  if (endpoint.startsWith('/contacts')) return 'contacts';
  if (endpoint.startsWith('/users')) return 'users';
  return 'locations';
}

export interface SyncRunResult {
  disabled: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  details: Array<{ id: string; operation: string; endpoint: string; status: 'succeeded' | 'failed'; error?: string }>;
}

export async function runSync(options: { limit?: number } = {}): Promise<SyncRunResult> {
  const result: SyncRunResult = { disabled: !ENABLE_WRITEBACK, processed: 0, succeeded: 0, failed: 0, details: [] };

  // Hard stop. See CLAUDE.md rule 1.
  if (!ENABLE_WRITEBACK) return result;

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
    .limit(options.limit ?? 500);

  for (const item of pending) {
    result.processed += 1;
    const request: GhlRequest = {
      method: item.method as GhlRequest['method'],
      endpoint: item.endpoint,
      family: familyForEndpoint(item.endpoint),
      body: JSON.parse(item.payload) as Record<string, unknown>,
    };
    const response = await ghlRequest(request);
    const now = new Date();
    if (response.ok) {
      await db
        .update(ghlSyncQueue)
        .set({ status: 'succeeded', attempts: item.attempts + 1, processedAt: now, lastError: null })
        .where(eq(ghlSyncQueue.id, item.id));
      result.succeeded += 1;
      result.details.push({ id: item.id, operation: item.operation, endpoint: item.endpoint, status: 'succeeded' });
    } else {
      await db
        .update(ghlSyncQueue)
        .set({ status: 'failed', attempts: item.attempts + 1, processedAt: now, lastError: response.error?.slice(0, 1000) })
        .where(eq(ghlSyncQueue.id, item.id));
      result.failed += 1;
      result.details.push({ id: item.id, operation: item.operation, endpoint: item.endpoint, status: 'failed', error: response.error });
    }
  }
  return result;
}

/** Counts for the legacy queue badge. Always zero in the read-only app. */
export async function getQueueStats(): Promise<{ pending: number; failed: number; succeeded: number; writebackEnabled: boolean }> {
  const all = await db.select({ status: ghlSyncQueue.status }).from(ghlSyncQueue);
  const count = (s: string) => all.filter((r) => r.status === s).length;
  return { pending: count('pending'), failed: count('failed'), succeeded: count('succeeded'), writebackEnabled: ENABLE_WRITEBACK };
}
