/**
 * "Is anything actually running us?" (Ingestion v2, 2026-09-30). The GitHub Actions heartbeat fired 3 times in 9
 * overnight hours — scheduled runs are best-effort, and a silent scheduler used to look like calm data. Vercel Pro
 * crons are now primary (hourly, staggered), GitHub every 6 h is the fallback, and every cron invocation records
 * itself here. No scheduled run for SCHEDULER_SILENT_AFTER_HOURS → ONE open critical `scheduler_silent` incident
 * (checked on every page view via /api/sync/status, and by each run), resolved by the next run.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';

export const SCHEDULER_SILENT_AFTER_HOURS = 3;
export type SchedulerVia = 'vercel' | 'github' | 'other';

export interface SchedulerLastRun {
  route: string;
  at: string;
  via: SchedulerVia;
}

/** Who called a cron route: Vercel's cron user agent, the GitHub fallback's header, or anything else holding the secret. */
export function schedulerVia(headers: { get(name: string): string | null }): SchedulerVia {
  if ((headers.get('user-agent') ?? '').toLowerCase().includes('vercel-cron')) return 'vercel';
  if (headers.get('x-fitflow-trigger') === 'github-heartbeat') return 'github';
  return 'other';
}

export async function recordScheduledRun(route: string, via: SchedulerVia, now: Date = new Date()): Promise<void> {
  await setSetting(SETTING_KEYS.schedulerLastRun, JSON.stringify({ route, at: now.toISOString(), via } satisfies SchedulerLastRun));
  await resolveSilence(now);
}

export async function readSchedulerLastRun(): Promise<SchedulerLastRun | null> {
  const raw = await getSetting(SETTING_KEYS.schedulerLastRun);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as SchedulerLastRun;
    return r && typeof r.at === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Pure: silent when the last scheduled run is older than the threshold, or never happened. */
export function schedulerSilence(last: SchedulerLastRun | null, now: number, hours = SCHEDULER_SILENT_AFTER_HOURS): { silent: boolean; ageHours: number | null; detail: string } {
  if (!last) return { silent: true, ageHours: null, detail: 'No scheduled sync has ever run — check the Vercel cron jobs (Project → Settings → Cron Jobs).' };
  const ageHours = (now - Date.parse(last.at)) / 3_600_000;
  const rounded = Math.round(ageHours * 10) / 10;
  if (ageHours <= hours) return { silent: false, ageHours: rounded, detail: `Last scheduled run ${rounded < 1 ? `${Math.round(ageHours * 60)} min` : `${rounded} h`} ago (${last.via}, ${last.route}).` };
  return { silent: true, ageHours: rounded, detail: `No scheduled sync since ${last.at} (${rounded} h, last via ${last.via}) — check the Vercel cron jobs.` };
}

/** Open / refresh / resolve the one `scheduler_silent` incident. Returns the silence verdict. */
export async function checkSchedulerSilence(now: Date = new Date()): Promise<ReturnType<typeof schedulerSilence> & { last: SchedulerLastRun | null }> {
  const last = await readSchedulerLastRun();
  const verdict = schedulerSilence(last, now.getTime());
  if (!verdict.silent) {
    await resolveSilence(now);
    return { ...verdict, last };
  }
  const [open] = await db.select({ id: syncIncidents.id }).from(syncIncidents).where(and(eq(syncIncidents.kind, 'scheduler_silent'), isNull(syncIncidents.resolvedAt))).limit(1);
  if (open) await db.update(syncIncidents).set({ message: verdict.detail }).where(eq(syncIncidents.id, open.id));
  else await db.insert(syncIncidents).values({ kind: 'scheduler_silent', severity: 'critical', message: verdict.detail, details: { lastRun: last } });
  return { ...verdict, last };
}

async function resolveSilence(now: Date): Promise<void> {
  await db.update(syncIncidents).set({ resolvedAt: now }).where(and(eq(syncIncidents.kind, 'scheduler_silent'), isNull(syncIncidents.resolvedAt)));
}
