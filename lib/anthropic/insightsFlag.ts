/**
 * The Insights card and its nightly generator are behind a flag, default OFF (2026-10-15): the generator predates
 * the Analyst's safeguards (numbers by reference, the verifier, computed verdicts and gates), so until it is rebuilt
 * on them nothing it writes reaches the owner. The generator code is kept; only the gate is new.
 *
 *   INSIGHTS_ENABLED unset / anything but 1|true|on  → paused:
 *     GET  /api/anthropic/insights → { paused: true, message: "Insights are being upgraded", findings: [] … }
 *     POST /api/anthropic/insights → 409 { ok: false, paused: true, reason: "paused pending Analyst rebuild" }
 *     dispatch step `insights`     → sync_runs status `skipped`, stats.reason "paused pending Analyst rebuild"
 *     the Command Center card      → one muted line "Insights are being upgraded"
 *   INSIGHTS_ENABLED=true → everything as before.
 */
export const INSIGHTS_PAUSED_TEXT = 'Insights are being upgraded';
export const INSIGHTS_PAUSED_REASON = 'paused pending Analyst rebuild';

export function insightsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on)$/i.test((env.INSIGHTS_ENABLED ?? '').trim());
}

/** The dispatch step's skip reason (null = run). */
export function insightsSkipReason(env: Record<string, string | undefined> = process.env): string | null {
  return insightsEnabled(env) ? null : INSIGHTS_PAUSED_REASON;
}
