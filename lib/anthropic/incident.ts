/**
 * ONE open `anthropic_error` incident (2026-09-30). An AI feature that fails
 * must be visible in Setup → Incidents, not only in a toast somebody missed.
 *
 *   transient (429 / 529 overloaded / 5xx / network — after one retry) → warning
 *   permanent (400 / 401 / 403 / other 4xx, invalid or missing structured answer) → critical
 *
 * A failure opens the incident or refreshes the open one (message, severity);
 * the next successful call resolves it. Local conditions that are not API
 * faults (the Ask rate limiter, a grounding discard, "not configured") never
 * reach here. Bookkeeping never breaks the caller.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';

export const ANTHROPIC_INCIDENT_KIND = 'anthropic_error';
export type AnthropicSeverity = 'warning' | 'critical';

export async function noteAnthropicOutcome(outcome: { ok: true } | { ok: false; error: string; severity: AnthropicSeverity; feature?: string }): Promise<void> {
  try {
    const [open] = await db
      .select({ id: syncIncidents.id })
      .from(syncIncidents)
      .where(and(eq(syncIncidents.kind, ANTHROPIC_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)))
      .limit(1);
    if (outcome.ok) {
      if (open) await db.update(syncIncidents).set({ resolvedAt: new Date() }).where(eq(syncIncidents.id, open.id));
      return;
    }
    const message = `AI request failed${outcome.feature ? ` (${outcome.feature})` : ''}: ${outcome.error}`;
    const details = { severity: outcome.severity, feature: outcome.feature ?? null, at: new Date().toISOString() };
    if (open) {
      await db.update(syncIncidents).set({ message, severity: outcome.severity, details }).where(eq(syncIncidents.id, open.id));
    } else {
      await db.insert(syncIncidents).values({ kind: ANTHROPIC_INCIDENT_KIND, severity: outcome.severity, message, details });
    }
  } catch {
    /* never let incident bookkeeping break an AI call */
  }
}
