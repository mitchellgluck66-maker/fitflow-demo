/** Companion stage 3 — the one data-health line every report carries: open incidents + stale sources. */

import { and, inArray, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { freshnessSummary, readSyncStatus } from '../sync/sourceFreshness';

export interface DataHealth {
  line: string;
  stale: boolean;
  openIncidents: number;
}

export async function dataHealth(now: Date = new Date()): Promise<DataHealth> {
  const [status, open] = await Promise.all([
    readSyncStatus(now.getTime()),
    db.select({ kind: syncIncidents.kind }).from(syncIncidents).where(and(isNull(syncIncidents.resolvedAt), inArray(syncIncidents.severity, ['warning', 'critical']))),
  ]);
  const f = freshnessSummary(status);
  const kinds = Array.from(new Set(open.map((o) => o.kind))).sort();
  const incidents = open.length === 0 ? 'no open incidents' : `${open.length} open incident${open.length === 1 ? '' : 's'} (${kinds.join(', ')}) — Setup → Incidents`;
  return { line: `Data health: ${f.line} · ${incidents}.`, stale: f.stale, openIncidents: open.length };
}
