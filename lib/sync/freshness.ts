/**
 * Family-level freshness (2026-09-29 production audit).
 *
 * Nineteen consecutive 'partial' GHL runs and zero completed cycles since
 * Sep 18: the cycle walked ALL pipelines' opportunities before ever reaching
 * appointments, so appointments were 11 days stale while every run row said
 * "partial — progressing". Staleness is therefore keyed off "the last time
 * the TRACKED phases completed" PER DATA FAMILY, never off run activity:
 *   stages_opportunities  the followed pipelines' opportunity pages
 *   appointments          the calendar events
 * Pure over its inputs so both /api/sync/status and /api/sync-health agree.
 */

export type GhlFamilyKey = 'stages_opportunities' | 'appointments';

export const GHL_FAMILIES: Array<{ key: GhlFamilyKey; label: string }> = [
  { key: 'stages_opportunities', label: 'pipeline stages & opportunities' },
  { key: 'appointments', label: 'appointments' },
];

/**
 * Data older than this is called out on every data page. 3 h since 2026-09-30 (Vercel Pro, hourly): every family
 * is refreshed each hour, so two missed hours is already news. (Was 26 h on the once-a-day Hobby schedule.)
 */
export const STALE_AFTER_HOURS = 3;
/** Runs kept happening but a family has not completed in this long → the banner says every run since was partial. */
export const PARTIAL_ONLY_AFTER_HOURS = 6;

export interface FamilyFreshness {
  key: GhlFamilyKey;
  label: string;
  /** When this family last COMPLETED inside a cycle (null = never). */
  completedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  /** Runs have happened since the last completion, for longer than the partial-only window. */
  partialOnly: boolean;
  /** One line for the banner / sync-health. */
  detail: string;
}

export function familyFreshness(input: {
  key: GhlFamilyKey;
  completedAt: Date | string | null;
  /** The newest GHL run of any status — the evidence that runs are happening. */
  lastRunAt: Date | string | null;
  now?: number;
  staleAfterHours?: number;
  partialOnlyAfterHours?: number;
}): FamilyFreshness {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterHours ?? STALE_AFTER_HOURS;
  const partialAfter = input.partialOnlyAfterHours ?? PARTIAL_ONLY_AFTER_HOURS;
  const label = GHL_FAMILIES.find((f) => f.key === input.key)?.label ?? input.key;
  const done = input.completedAt ? new Date(input.completedAt) : null;
  const doneMs = done && !Number.isNaN(done.getTime()) ? done.getTime() : null;
  const lastRun = input.lastRunAt ? new Date(input.lastRunAt) : null;
  const lastRunMs = lastRun && !Number.isNaN(lastRun.getTime()) ? lastRun.getTime() : null;
  const ageHours = doneMs === null ? null : (now - doneMs) / 3_600_000;
  const stale = ageHours === null || ageHours > staleAfter;
  const partialOnly = lastRunMs !== null && (doneMs === null || lastRunMs > doneMs) && (ageHours === null ? now - lastRunMs > partialAfter * 3_600_000 : ageHours > partialAfter);
  const age = ageHours === null ? 'never' : ageHours < 1 ? `${Math.round(ageHours * 60)} min ago` : ageHours < 48 ? `${Math.round(ageHours)} h ago` : `${Math.round(ageHours / 24)} days ago`;
  const detail = doneMs === null
    ? `${label}: never completed${partialOnly ? ' — runs since have all been partial' : ''}`
    : `${label}: last completed ${age}${partialOnly ? ' — every run since has been partial' : ''}`;
  return { key: input.key, label, completedAt: doneMs === null ? null : new Date(doneMs).toISOString(), ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10, stale, partialOnly, detail };
}

/**
 * Freshness of any marker family (lib/sync/markers.ts) — pure. The banner and Sync health read markers ONLY:
 * a family is stale when its marker is older than STALE_AFTER_HOURS or does not exist.
 */
export function markerFreshness(input: {
  label: string;
  marker: { completedAt: string; fetched: number; detail?: string } | null;
  now?: number;
  staleAfterHours?: number;
}): { label: string; completedAt: string | null; ageHours: number | null; stale: boolean; fetched: number | null; detail: string } {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterHours ?? STALE_AFTER_HOURS;
  if (!input.marker) return { label: input.label, completedAt: null, ageHours: null, stale: true, fetched: null, detail: `${input.label}: never completed` };
  const ageHours = (now - Date.parse(input.marker.completedAt)) / 3_600_000;
  const age = ageHours < 1 ? `${Math.max(0, Math.round(ageHours * 60))} min ago` : ageHours < 48 ? `${Math.round(ageHours)} h ago` : `${Math.round(ageHours / 24)} days ago`;
  return {
    label: input.label,
    completedAt: input.marker.completedAt,
    ageHours: Math.round(ageHours * 10) / 10,
    stale: ageHours > staleAfter,
    fetched: input.marker.fetched,
    detail: `${input.label}: last completed ${age}${input.marker.detail ? ` (${input.marker.detail})` : ''}`,
  };
}
