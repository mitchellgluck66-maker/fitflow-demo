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
 *
 * 2026-09-30 (production: stripe timed out at 25 s, then reconcile / sweep /
 * prune / insights / daily were "time budget reached" on EVERY run for days —
 * the daily to-do never sent):
 *   - FAIRNESS: `orderSteps` runs never-succeeded and starved steps first,
 *     then the least-recently-successful, so a budget-deferred step is at the
 *     front of the next run. `after` keeps real dependencies (narrative before
 *     its digest) whatever the ranking.
 *   - HONEST STATUS: a budget skip is `deferred`, not an error. `assessDispatch`
 *     → HTTP 200 with partial:true for deferrals / single timeouts; 500 ONLY
 *     when a step failed, or the same step timed out / was deferred
 *     STUCK_THRESHOLD consecutive runs (then an incident names it).
 *   - History lives in settings.dispatch_state (`nextDispatchState`).
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
  /** Steps that must run earlier in the same dispatch when both are present (e.g. a narrative before its digest). */
  after?: string[];
}

export type StepOutcome =
  | { status: 'succeeded'; durationMs: number; result: unknown }
  | { status: 'failed'; durationMs: number; error: string; result?: unknown }
  | { status: 'timed_out'; durationMs: number; error: string }
  | { status: 'skipped'; reason: string }
  /** Not started because the invocation budget ran out — it goes to the front of the next dispatch. */
  | { status: 'deferred'; reason: string };

export interface DispatchOutcome {
  ok: boolean;
  order: string[];
  steps: Record<string, StepOutcome>;
  durationMs: number;
}

/** Vercel Pro (2026-09-30): maxDuration 300 s. A step gets 60 s unless it says otherwise. */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000;
/** Do not START a new step after this much wall time — leaves a step's timeout inside the 300 s maxDuration. */
export const DEFAULT_DISPATCH_BUDGET_MS = 110_000;

/** A step whose source / key is not connected did NOTHING — it is `skipped` with this reason, never `succeeded` (2026-09-30). */
export const NOT_CONFIGURED_REASON = 'not configured — no credentials for this step';

function isNotConfigured(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as { notConfigured?: unknown }).notConfigured);
}

function failedResult(result: unknown): string | null {
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false) {
    const r = result as { notConfigured?: unknown; error?: unknown };
    if (r.notConfigured) return null; // not connected is not a failure (it is a skip — see runDispatch)
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
  if (outcome.status === 'skipped' || outcome.status === 'deferred') return outcome.reason;
  if (outcome.status === 'timed_out') return outcome.error;
  if (outcome.status === 'failed') return outcome.error;
  const r = outcome.result;
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.skipped === 'string' && o.skipped) return o.skipped;
  if (typeof o.reason === 'string' && o.reason) return o.reason;
  if (o.notConfigured) return NOT_CONFIGURED_REASON;
  if (o.partial === true) return typeof o.progress === 'string' && o.progress ? `partial — ${o.progress}` : 'partial — the cycle continues next run';
  if (typeof o.status === 'string' && o.status !== 'sent' && o.status !== 'succeeded' && o.status !== 'ok') {
    const err = typeof o.error === 'string' && o.error ? ` — ${o.error}` : '';
    if (o.status === 'stored') return `stored, not sent — RESEND_API_KEY / RESEND_FROM_EMAIL not configured${err}`;
    if (o.status === 'skipped_empty') return 'skipped — the digest was empty';
    if (o.status === 'already_sent') return 'already sent for this period';
    if (o.status === 'already_recorded') return `${o.error ?? 'already recorded for this period'} — not re-archived`;
    if (o.status === 'retries_exhausted') return `gave up — ${o.error ?? 'too many failed attempts for this period'}`;
    if (o.status === 'disabled') return 'disabled on /reports';
    return `${o.status}${err}`;
  }
  if (Array.isArray(o.findings) && o.cached === false) return `generated ${o.findings.length} finding${o.findings.length === 1 ? '' : 's'}`;
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
      outcome = { status: 'deferred', reason: 'time budget reached before this step; it runs first on the next dispatch' };
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
          outcome = isNotConfigured(result)
            ? { status: 'skipped', reason: NOT_CONFIGURED_REASON }
            : err
              ? { status: 'failed', durationMs: now() - t0, error: err, result }
              : { status: 'succeeded', durationMs: now() - t0, result };
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

  const ok = Object.values(outcomes).every((o) => o.status === 'succeeded' || o.status === 'skipped' || o.status === 'deferred');
  return { ok, order, steps: outcomes, durationMs: now() - startedAt };
}

// ---------------------------------------------------------------------------
// Fairness + stuck detection (2026-09-30). Pure; the route persists the state.
// ---------------------------------------------------------------------------

/** A step timed out or was deferred this many consecutive dispatches → stuck: HTTP 500 + an incident. */
export const STUCK_THRESHOLD = 3;

export interface StepHistory {
  /** ISO time of the last run whose outcome was `succeeded`. */
  lastSucceededAt?: string;
  /** Consecutive dispatches in which the step timed out or was deferred. Reset by any other outcome. */
  stuck: number;
  lastStuck?: 'timed_out' | 'deferred';
}
export type DispatchState = Record<string, StepHistory>;

export function parseDispatchState(raw: string | null | undefined): DispatchState {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as DispatchState) : {};
  } catch {
    return {};
  }
}

/**
 * Run order for one dispatch: (a) steps that never succeeded or are starved
 * (stuck > 0) first — most-starved first — then (b) the rest by least-recently
 * successful. Ties keep the declared order. A step's `after` dependencies
 * (when present in this run) are pulled forward to run just before it.
 */
export function orderSteps<T extends Pick<DispatchStep, 'name' | 'after'>>(steps: T[], state: DispatchState): T[] {
  const declared = new Map(steps.map((s, i) => [s.name, i]));
  const rank = (s: T) => {
    const h = state[s.name];
    const starved = !h?.lastSucceededAt || (h?.stuck ?? 0) > 0;
    return { group: starved ? 0 : 1, stuck: h?.stuck ?? 0, last: h?.lastSucceededAt ? Date.parse(h.lastSucceededAt) : 0 };
  };
  const sorted = [...steps].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra.group !== rb.group) return ra.group - rb.group;
    if (ra.group === 0 && ra.stuck !== rb.stuck) return rb.stuck - ra.stuck;
    if (ra.group === 1 && ra.last !== rb.last) return ra.last - rb.last;
    return declared.get(a.name)! - declared.get(b.name)!;
  });
  // Dependencies are HOISTED to just before their dependent (they inherit its priority) — a starved step is never
  // held back behind a dependency that ranks low.
  const byName = new Map(steps.map((s) => [s.name, s]));
  const out: T[] = [];
  const placed = new Set<string>();
  const place = (s: T, seen: Set<string>) => {
    if (placed.has(s.name) || seen.has(s.name)) return;
    seen.add(s.name);
    for (const d of s.after ?? []) {
      const dep = byName.get(d);
      if (dep) place(dep, seen);
    }
    out.push(s);
    placed.add(s.name);
  };
  for (const s of sorted) place(s, new Set());
  return out;
}

/** Fold one dispatch's outcomes into the history. */
export function nextDispatchState(state: DispatchState, outcomes: Record<string, StepOutcome>, nowIso: string): DispatchState {
  const out: DispatchState = { ...state };
  for (const [name, o] of Object.entries(outcomes)) {
    const prev = state[name] ?? { stuck: 0 };
    if (o.status === 'timed_out' || o.status === 'deferred') {
      out[name] = { ...prev, stuck: (prev.stuck ?? 0) + 1, lastStuck: o.status };
    } else {
      out[name] = { ...prev, stuck: 0, lastStuck: undefined, ...(o.status === 'succeeded' ? { lastSucceededAt: nowIso } : {}) };
    }
  }
  return out;
}

export interface DispatchAssessment {
  /** 200 unless something is actually broken. */
  httpStatus: 200 | 500;
  ok: boolean;
  /** Some step was deferred or timed out this run (it continues next run). */
  partial: boolean;
  failed: Array<{ name: string; error: string }>;
  stuck: Array<{ name: string; count: number; as: 'timed_out' | 'deferred' }>;
  deferred: string[];
}

/** The status contract: 5xx only for a failure or a step stuck STUCK_THRESHOLD runs in a row. */
export function assessDispatch(outcomes: Record<string, StepOutcome>, state: DispatchState, threshold = STUCK_THRESHOLD): DispatchAssessment {
  const failed: DispatchAssessment['failed'] = [];
  const stuck: DispatchAssessment['stuck'] = [];
  const deferred: string[] = [];
  for (const [name, o] of Object.entries(outcomes)) {
    if (o.status === 'failed') failed.push({ name, error: o.error });
    if (o.status === 'timed_out' || o.status === 'deferred') {
      deferred.push(name);
      const count = state[name]?.stuck ?? 0;
      if (count >= threshold) stuck.push({ name, count, as: o.status });
    }
  }
  const ok = failed.length === 0 && stuck.length === 0;
  return { httpStatus: ok ? 200 : 500, ok, partial: deferred.length > 0, failed, stuck, deferred };
}

/** The dispatch runs GHL itself only when no GHL run has finished OK (succeeded / partial) for this long. */
export const GHL_FALLBACK_AFTER_MS = 2 * 60 * 60 * 1000;

/** Skip reason for the dispatch's ghl step, or null when the fallback is due. */
export function ghlFallbackGate(lastOkFinishedAt: Date | null, now: Date): string | null {
  if (!lastOkFinishedAt) return null;
  const ageMs = now.getTime() - lastOkFinishedAt.getTime();
  if (ageMs >= GHL_FALLBACK_AFTER_MS) return null;
  return `GHL synced ${Math.max(0, Math.round(ageMs / 60_000))} min ago (/api/cron/sync-ghl) — the dispatch runs GHL only as a fallback after ${GHL_FALLBACK_AFTER_MS / 3_600_000} h`;
}

/** Skip reason for reconcile, or null when eligible: the followed pipeline was fully read (its marker) and no GHL run
 *  holds the lease right now (a moving mirror is not worth comparing). Ingestion v2 (2026-09-30). */
export function reconcileGate(input: { trackedCompletedAt: string | null; ghlRunLive: boolean }): string | null {
  if (input.ghlRunLive) return 'a GHL sync is running — reconcile waits for a still mirror';
  if (!input.trackedCompletedAt) return 'waiting for the first complete read of the followed pipeline (no ghl.opportunities marker yet)';
  return null;
}
