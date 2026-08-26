/**
 * Midnight auto-sync scheduler.
 *
 * Runs in-process alongside the Next.js dev/prod server. At local midnight it
 * drains the GHL outbox, so a day's attendance marks land in GoHighLevel without
 * anyone remembering to press a button.
 *
 * Why a self-rescheduling timeout rather than a fixed interval: the gap to
 * midnight changes with DST, and a naive 24h interval drifts an hour twice a
 * year. Recomputing the delay after every run keeps it anchored to the actual
 * local day boundary.
 *
 * For a single-machine deployment this is the right amount of machinery. If this
 * ever runs on multiple instances, move the trigger to an external cron hitting
 * POST /api/sync so the job doesn't fire once per instance.
 */

import { msUntilMidnight } from './day';

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let lastRun: { at: string; result: unknown } | null = null;

async function executeSync(): Promise<void> {
  try {
    // Imported lazily so the scheduler module stays safe to import from
    // anywhere without dragging the DB connection along at module load.
    const { runSync } = await import('./ghl/sync');
    const { setSetting, SETTING_KEYS, getSetting } = await import('./settings');

    const enabled = await getSetting(SETTING_KEYS.autoSyncEnabled);
    if (enabled === 'false') {
      console.log('[scheduler] Auto-sync disabled in settings, skipping.');
      return;
    }

    console.log('[scheduler] Midnight sync starting…');
    const result = await runSync();

    lastRun = { at: new Date().toISOString(), result };
    await setSetting(SETTING_KEYS.lastAutoSyncAt, new Date().toISOString());

    console.log(
      `[scheduler] Midnight sync complete: ${result.succeeded}/${result.processed} operations, ` +
        `${result.appointmentsSynced} appointments${result.dryRun ? ' (DRY RUN)' : ''}`,
    );
  } catch (error) {
    console.error('[scheduler] Midnight sync failed:', error);
  }
}

function scheduleNext(timezone: string): void {
  if (timer) clearTimeout(timer);

  const delay = msUntilMidnight(timezone);
  const hours = (delay / 3_600_000).toFixed(1);
  console.log(`[scheduler] Next auto-sync in ${hours}h (${timezone})`);

  timer = setTimeout(async () => {
    await executeSync();
    // Re-anchor to the next real midnight rather than adding a fixed 24h.
    scheduleNext(timezone);
  }, delay);

  // Don't hold the process open just for this timer.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
}

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const { getTimezone } = await import('./settings');
    const timezone = await getTimezone();
    scheduleNext(timezone);
  } catch (error) {
    console.error('[scheduler] Failed to start:', error);
    started = false;
  }
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

export function getSchedulerStatus(): {
  running: boolean;
  lastRun: { at: string; result: unknown } | null;
} {
  return { running: started, lastRun };
}

/** Manual trigger, exposed for the "Run midnight sync now" button in Settings. */
export async function triggerSyncNow(): Promise<void> {
  await executeSync();
}
