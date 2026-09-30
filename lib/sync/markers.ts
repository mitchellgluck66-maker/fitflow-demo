/**
 * Freshness markers that cannot lie (Ingestion v2, 2026-09-30).
 *
 * F1: the old cycle wrote "tracked opportunities completed = now" from the APPOINTMENTS block, for a pipeline it
 * had not read in 11 days, and the banner said fresh. A marker is now written ONLY by the code path that just
 * fetched that family, in that run, after the fetch completed — with how much it fetched (and, where the source
 * reports it, the source's own total). The stale banner and Sync health read these and nothing else.
 */

import { getSetting, setSetting } from '../settings';

export type MarkerFamily =
  | 'ghl.opportunities'
  | 'ghl.appointments'
  | 'ghl.mirrors'
  | 'meta.spend'
  | 'stripe.payments'
  | 'stripe.completeness'
  | 'fx.rates';

export interface Marker {
  family: MarkerFamily;
  /** When the fetch of this family completed (ISO). */
  completedAt: string;
  /** sync_runs id of the run that did it (null for a webhook or a script without a run row). */
  runId: string | null;
  /** Rows this fetch read from the source. */
  fetched: number;
  /** The source's own count, when it reports one (GHL meta.total) — fetched === liveTotal or the walk is incomplete. */
  liveTotal?: number | null;
  /** One short line (e.g. "1 pipeline · 401 opportunities"). */
  detail?: string;
}

const key = (family: MarkerFamily) => `marker:${family}`;

export async function writeMarker(m: Omit<Marker, 'completedAt'> & { completedAt?: string }): Promise<Marker> {
  const marker: Marker = { ...m, completedAt: m.completedAt ?? new Date().toISOString() };
  await setSetting(key(m.family), JSON.stringify(marker));
  return marker;
}

export async function readMarker(family: MarkerFamily): Promise<Marker | null> {
  const raw = await getSetting(key(family));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Marker;
    return m && typeof m.completedAt === 'string' && !Number.isNaN(Date.parse(m.completedAt)) ? m : null;
  } catch {
    return null;
  }
}
