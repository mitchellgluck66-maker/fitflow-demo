/**
 * Dispatch runner — the isolation layer under /api/cron/dispatch.
 *
 * Production finding (2026-09-18): Stripe went 16 days without a reconcile
 * because the dispatch chain died on GHL's timeout before reaching the later
 * steps. Rules now:
 *   - every step runs inside its own try/catch AND a per-step timeout race,
 *     so one source's failure or hang never prevents the others;
 *   - cheap, critical steps go first (Stripe, Meta) and the long GHL walk —
 *     itself budgeted and resumable — later; digests last;
 *   - every outcome is recorded separately: sources write their own sync_runs
 *     rows, everything else gets a `dispatch:<step>` row via `record`;
 *   - a step that would start after the invocation budget is recorded as
 *     skipped, never silently dropped.
 * Pure over its inputs (steps + clock) so it is unit-testable.
 */

export interface DispatchStep {
  name: string;
  /** Skip with this reason instead of running (e.g. "not Monday"). */
  skip?: string | null;
  run: () => Promise<unknown>;
  /** Give up waiting after this long; the step is recorded as timed out. */
  timeoutMs?: number;
  /** True when the step writes its own sync_runs row (sources); false → dispatch records one. */
  ownsRun?: boolean;
}

export type StepOutcome =
  | { status: 'succeeded'; durationMs: number; result: unknown }
  | { status: 'failed'; durationMs: number; error: string; result?: unknown }
  | { status: 'timed_out'; durationMs: number; error: string }
  | { status: 'skipped'; reason: string };

export interface DispatchOutcome {
  ok: boolean;
  order: string[];
  steps: Record<string, StepOutcome>;
  durationMs: number;
}

export const DEFAULT_STEP_TIMEOUT_MS = 25_000;
/** Do not START a new step after this much wall time (Vercel Hobby kills at 60s). */
export const DEFAULT_DISPATCH_BUDGET_MS = 52_000;

function failedResult(result: unknown): string | null {
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false) {
    const r = result as { notConfigured?: unknown; error?: unknown };
    if (r.notConfigured) return null; // not connected is not a failure
    return typeof r.error === 'string' ? r.error : 'step reported ok=false';
  }
  return null;
}

/**
 * What a step's `sync_runs` row records in `stats` (2026-09-29): a skipped
 * step carries its reason, a failed / timed-out one its error, and a step that
 * "succeeded" by doing nothing says why — a digest stored for want of
 * RESEND_API_KEY, a not-connected source, a reconcile waiting for the tracked
 * phases, a partial GHL run's pause point. An empty {} is not observability.
 */
export function statsForOutcome(outcome: StepOutcome): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if ('durationMs' in outcome) out.durationMs = outcome.durationMs;
  const reason = outcomeReason(outcome);
  if (reason) out.reason = reason;
  return out;
}

/** The one-line reason behind an outcome, read from the outcome itself or the step's own result. Null when it simply ran. */
export function outcomeReason(outcome: StepOutcome): string | null {
  if (outcome.status === 'skipped') return outcome.reason;
  if (outcome.status === 'timed_out') return outcome.error;
  if (outcome.status === 'failed') return outcome.error;
  const r = outcome.result;
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.skipped === 'string' && o.skipped) return o.skipped;
  if (typeof o.reason === 'string' && o.reason) return o.reason;
  if (o.notConfigured) return 'not configured — no credentials for this step';
  if (o.partial === true) return typeof o.progress === 'string' && o.progress ? `partial — ${o.progress}` : 'partial — the cycle continues next run';
  if (typeof o.status === 'string' && o.status !== 'sent' && o.status !== 'succeeded' && o.status !== 'ok') {
    const err = typeof o.error === 'string' && o.error ? ` — ${o.error}` : '';
    if (o.status === 'stored') return `stored, not sent — RESEND_API_KEY / RESEND_FROM_EMAIL not configured${err}`;
    if (o.status === 'skipped_empty') return 'skipped — the digest was empty';
    if (o.status === 'already_sent') return 'already sent for this period';
    if (o.status === 'disabled') return 'disabled on /reports';
    return `${o.status}${err}`;
  }
  if (o.cached === true) return 'served from cache — inputs unchanged';
  return null;
}

export async function runDispatch(
  steps: DispatchStep[],
  opts: { record?: (name: string, outcome: StepOutcome) => Promise<void>; now?: () => number; budgetMs?: number } = {},
): Promise<DispatchOutcome> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DEFAULT_DISPATCH_BUDGET_MS;
  const startedAt = now();
  const outcomes: Record<string, StepOutcome> = {};
  const order: string[] = [];

  for (const step of steps) {
    order.push(step.name);
    let outcome: StepOutcome;
    if (step.skip) {
      outcome = { status: 'skipped', reason: step.skip };
    } else if (now() - startedAt >= budgetMs) {
      outcome = { status: 'skipped', reason: 'time budget reached before this step; it runs on the next dispatch' };
    } else {
      const t0 = now();
      const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'__timeout__'>((resolve) => {
        timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
      });
      try {
        const result = await Promise.race([step.run(), timeout]);
        if (result === '__timeout__') {
          outcome = { status: 'timed_out', durationMs: now() - t0, error: `no result after ${Math.round(timeoutMs / 1000)}s — moved on; the step's own run row shows what happened` };
        } else {
          const err = failedResult(result);
          outcome = err ? { status: 'failed', durationMs: now() - t0, error: err, result } : { status: 'succeeded', durationMs: now() - t0, result };
        }
      } catch (err) {
        outcome = { status: 'failed', durationMs: now() - t0, error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    outcomes[step.name] = outcome;
    if (opts.record && !step.ownsRun) {
      try {
        await opts.record(step.name, outcome);
      } catch {
        /* recording must never break the chain */
      }
    }
  }

  const ok = Object.values(outcomes).every((o) => o.status === 'succeeded' || o.status === 'skipped');
  return { ok, order, steps: outcomes, durationMs: now() - startedAt };
}
