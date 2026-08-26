/**
 * Next.js instrumentation hook - runs once when the server process starts.
 * Used to boot the midnight auto-sync scheduler.
 *
 * The nodejs runtime guard matters: this file is also evaluated in the edge
 * runtime, where timers and the SQLite driver are unavailable.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    await startScheduler();
  }
}
