/**
 * Companion stage 2, item 5 — the `companion_actions` rows: insert (idempotent by request id), the per-step
 * updates, the readers for My day / Setup / undo. APPEND-ONLY: this module has no delete and nothing else may add
 * one (`tests/companion-log.test.ts` greps for it).
 */

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, companionActions, type CompanionAction, type CompanionActionState, type CompanionStepName, type CompanionStepRecord, type CompanionSteps, type NewCompanionAction } from '@/db';

/** How long Undo stays available after a log. */
export const UNDO_WINDOW_MS = 5 * 60_000;
/** A row still `running` this long after its last update is presented as failed (the function stopped mid-way). */
export const RUNNING_STALE_MS = 2 * 60_000;

export const STEP_ORDER: readonly CompanionStepName[] = ['stage', 'appointment', 'note'];

export function pendingStep(): CompanionStepRecord {
  return { status: 'pending', request: null, httpStatus: null, body: null, error: null, reason: null, at: null };
}
export function skippedStep(reason: string, at: Date): CompanionStepRecord {
  return { status: 'skipped', request: null, httpStatus: null, body: null, error: null, reason, at: at.toISOString() };
}

/** Pure: the state a set of step results implies. */
export function stateOfSteps(steps: CompanionSteps, dryRun: boolean): CompanionActionState {
  const records = STEP_ORDER.map((n) => steps[n]).filter((r): r is CompanionStepRecord => Boolean(r));
  const applied = records.filter((r) => r.status === 'ok').length;
  const failed = records.filter((r) => r.status === 'failed').length;
  // A failed step stops the sequence: the steps after it stay `pending` (not attempted) and the row is partial /
  // failed, never running. Without a failure, a pending step means the sequence is still going.
  if (failed > 0) return applied > 0 ? 'partial' : 'failed';
  if (records.some((r) => r.status === 'pending')) return 'running';
  if (dryRun) return 'dry_run';
  return 'ok';
}

/** Pure: a `running` row nobody has touched for RUNNING_STALE_MS is a failure the user can retry. */
export function effectiveState(row: Pick<CompanionAction, 'state' | 'updatedAt' | 'steps'>, now: Date): { state: CompanionActionState; stale: boolean } {
  if (row.state === 'running' && now.getTime() - row.updatedAt.getTime() > RUNNING_STALE_MS) {
    const applied = STEP_ORDER.some((n) => row.steps[n]?.status === 'ok');
    return { state: applied ? 'partial' : 'failed', stale: true };
  }
  return { state: row.state, stale: false };
}

/** Pure: the first failed (or stale-pending) step's name, for the chip and the incident. */
export function failedStepOf(steps: CompanionSteps): CompanionStepName | null {
  for (const n of STEP_ORDER) {
    const r = steps[n];
    if (r && (r.status === 'failed' || r.status === 'pending')) return n;
  }
  return null;
}

export function undoUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UNDO_WINDOW_MS);
}

/** Insert a new log, or return the existing row for the same request id (idempotent). */
export async function insertOrFindAction(values: NewCompanionAction & { requestId: string }): Promise<{ row: CompanionAction; created: boolean }> {
  const inserted = await db.insert(companionActions).values(values).onConflictDoNothing({ target: companionActions.requestId }).returning();
  if (inserted[0]) return { row: inserted[0], created: true };
  const existing = await db.select().from(companionActions).where(eq(companionActions.requestId, values.requestId)).limit(1);
  if (!existing[0]) throw new Error(`companion_actions: request ${values.requestId} neither inserted nor found`);
  return { row: existing[0], created: false };
}

export async function getAction(id: string): Promise<CompanionAction | null> {
  const rows = await db.select().from(companionActions).where(eq(companionActions.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Write one step's result and the state it implies, in one statement (the row is the ledger). */
export async function recordStep(id: string, name: CompanionStepName, record: CompanionStepRecord, opts: { dryRun: boolean; error?: string | null }): Promise<CompanionAction> {
  const current = await getAction(id);
  if (!current) throw new Error(`companion_actions ${id} is missing`);
  const steps: CompanionSteps = { ...current.steps, [name]: record };
  const state = stateOfSteps(steps, opts.dryRun);
  const rows = await db
    .update(companionActions)
    .set({ steps, state, error: opts.error === undefined ? (record.status === 'failed' ? record.error : current.error) : opts.error, updatedAt: new Date() })
    .where(eq(companionActions.id, id))
    .returning();
  return rows[0];
}

export async function setActionState(id: string, patch: Partial<Pick<CompanionAction, 'state' | 'error' | 'steps' | 'undoSteps' | 'undoneAt' | 'undoneBy' | 'after'>>): Promise<CompanionAction> {
  const rows = await db.update(companionActions).set({ ...patch, updatedAt: new Date() }).where(eq(companionActions.id, id)).returning();
  if (!rows[0]) throw new Error(`companion_actions ${id} is missing`);
  return rows[0];
}

/** The newest log per event id (for the chips) — only rows that still count: not undone. */
export async function actionsForEvents(eventIds: string[]): Promise<Map<string, CompanionAction>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db.select().from(companionActions).where(inArray(companionActions.ghlEventId, eventIds)).orderBy(desc(companionActions.createdAt));
  const out = new Map<string, CompanionAction>();
  for (const r of rows) {
    if (!r.ghlEventId || out.has(r.ghlEventId)) continue;
    if (r.state === 'undone') continue;
    out.set(r.ghlEventId, r);
  }
  return out;
}

/** The newest live (not undone) log for a contact, for the pop-out's "last logged" line. */
export async function latestActionForContact(ghlContactId: string): Promise<CompanionAction | null> {
  const rows = await db.select().from(companionActions).where(eq(companionActions.ghlContactId, ghlContactId)).orderBy(desc(companionActions.createdAt)).limit(1);
  return rows[0] ?? null;
}

export interface FailedActionSummary {
  id: string;
  state: CompanionActionState;
  clientName: string;
  label: string;
  userName: string;
  createdAt: string;
  failedStep: CompanionStepName | null;
  error: string | null;
  ghlContactId: string;
}

/** Partial / failed logs (and stale running ones) for the owner — Setup → Companion. */
export async function listFailedActions(now: Date = new Date(), limit = 50): Promise<FailedActionSummary[]> {
  const rows = await db
    .select()
    .from(companionActions)
    .where(inArray(companionActions.state, ['partial', 'failed', 'running']))
    .orderBy(desc(companionActions.createdAt))
    .limit(limit);
  const out: FailedActionSummary[] = [];
  for (const r of rows) {
    const e = effectiveState(r, now);
    if (e.state === 'running') continue;
    out.push({ id: r.id, state: e.state, clientName: r.clientName, label: r.label, userName: r.userName, createdAt: r.createdAt.toISOString(), failedStep: failedStepOf(r.steps), error: e.stale ? 'the function stopped mid-way and nothing resumed it' : r.error, ghlContactId: r.ghlContactId });
  }
  return out;
}


/** Rows in a window (the live test's summary and the day's "logged" count). */
export async function listActionsBetween(from: Date, to: Date): Promise<CompanionAction[]> {
  return db.select().from(companionActions).where(and(gte(companionActions.createdAt, from), lte(companionActions.createdAt, to))).orderBy(desc(companionActions.createdAt));
}

export const countActions = async (): Promise<number> => {
  const r = await db.select({ n: sql<number>`count(*)::int` }).from(companionActions);
  return r[0]?.n ?? 0;
};
