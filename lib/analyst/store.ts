/**
 * The Analyst store (plan item 5): threads, turns and the append-only API log,
 * behind one interface with a database implementation and an in-memory one
 * (the smoke and the eval run against production without writing a row).
 *
 * Log rules: `api_json` holds each API message as TEXT, exactly as sent or
 * received (jsonb would reorder keys and break the byte-identical replay that
 * preserved thinking needs). An assistant message and its tool results are
 * written in ONE transaction, so the log always ends in a replayable state.
 * A `compaction` row marks the new start of the API history; the visible
 * transcript is never deleted.
 */

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db, analystMessages, analystThreads, analystTurns } from '@/db';
import type { AnalystModel, AnswerMode, Effort } from './config';

export type MessageRole = 'user' | 'assistant' | 'tool_results' | 'compaction';
export type TurnStatus = 'running' | 'done' | 'failed' | 'stopped' | 'needs_confirmation';
export type TurnKind = 'ask' | 'explain' | 'report';

export interface ThreadRow {
  id: string;
  title: string | null;
  model: AnalystModel;
  effort: Effort;
  answerMode: AnswerMode;
  briefHash: string | null;
  archived: boolean;
  createdAt: Date;
  lastTurnAt: Date | null;
}

export interface MessageRow {
  id: string;
  threadId: string;
  seq: number;
  turnId: string | null;
  role: MessageRole;
  apiJson: string;
  display: Record<string, unknown> | null;
  createdAt: Date;
}

export interface TurnRow {
  id: string;
  threadId: string;
  clientTurnId: string;
  status: TurnStatus;
  question: string;
  kind: TurnKind;
  pageContext: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  heartbeatAt: Date;
  stopRequested: boolean;
  rounds: number;
  usage: Record<string, number> | null;
  costUsd: number;
  costEstimated: boolean;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface NewMessage {
  turnId: string | null;
  role: MessageRole;
  apiJson: string;
  display?: Record<string, unknown> | null;
}

export interface AnalystStore {
  createThread(t: { model: AnalystModel; effort: Effort; answerMode: AnswerMode; briefHash: string | null; title?: string | null }): Promise<ThreadRow>;
  getThread(id: string): Promise<ThreadRow | null>;
  listThreads(limit?: number): Promise<ThreadRow[]>;
  updateThread(id: string, patch: Partial<Pick<ThreadRow, 'title' | 'briefHash' | 'archived' | 'lastTurnAt'>>): Promise<void>;

  /** Append rows atomically at the next seqs. Returns the rows with their seqs. */
  appendMessages(threadId: string, rows: NewMessage[]): Promise<MessageRow[]>;
  listMessages(threadId: string): Promise<MessageRow[]>;

  /** Idempotent on (threadId, clientTurnId): a repeated POST returns the existing turn with `created: false`. */
  createTurn(t: { threadId: string; clientTurnId: string; question: string; kind: TurnKind; pageContext: Record<string, unknown> | null }): Promise<{ turn: TurnRow; created: boolean }>;
  getTurn(id: string): Promise<TurnRow | null>;
  /** The live turn of a thread (status running / needs_confirmation), if any. */
  liveTurn(threadId: string): Promise<TurnRow | null>;
  updateTurn(id: string, patch: Partial<Pick<TurnRow, 'status' | 'rounds' | 'usage' | 'costUsd' | 'costEstimated' | 'error' | 'finishedAt' | 'stopRequested'>>): Promise<void>;
  /** Append a progress event and refresh the heartbeat. */
  appendEvent(turnId: string, event: Record<string, unknown>): Promise<number>;
  /** Refresh the heartbeat without an event (a long stream). */
  heartbeat(turnId: string): Promise<void>;
  /** USD spent by turns started at/after `since`. */
  spentUsdSince(since: Date): Promise<number>;
  /** Amendment 1: running turns whose heartbeat is older than `olderThan` → failed with the reason. Returns them. */
  sweepOrphans(olderThan: Date, reason: string): Promise<TurnRow[]>;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const asThread = (r: typeof analystThreads.$inferSelect): ThreadRow => ({ id: r.id, title: r.title, model: r.model as AnalystModel, effort: r.effort as Effort, answerMode: r.answerMode as AnswerMode, briefHash: r.briefHash, archived: r.archived, createdAt: r.createdAt, lastTurnAt: r.lastTurnAt });
const asMessage = (r: typeof analystMessages.$inferSelect): MessageRow => ({ id: r.id, threadId: r.threadId, seq: r.seq, turnId: r.turnId, role: r.role as MessageRole, apiJson: r.apiJson, display: r.display ?? null, createdAt: r.createdAt });
const asTurn = (r: typeof analystTurns.$inferSelect): TurnRow => ({ id: r.id, threadId: r.threadId, clientTurnId: r.clientTurnId, status: r.status as TurnStatus, question: r.question, kind: r.kind as TurnKind, pageContext: r.pageContext ?? null, events: r.events ?? [], heartbeatAt: r.heartbeatAt, stopRequested: r.stopRequested, rounds: r.rounds, usage: r.usage ?? null, costUsd: r.costUsd, costEstimated: r.costEstimated, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt });

export class DbAnalystStore implements AnalystStore {
  async createThread(t: { model: AnalystModel; effort: Effort; answerMode: AnswerMode; briefHash: string | null; title?: string | null }): Promise<ThreadRow> {
    const [row] = await db.insert(analystThreads).values({ model: t.model, effort: t.effort, answerMode: t.answerMode, briefHash: t.briefHash, title: t.title ?? null }).returning();
    return asThread(row);
  }
  async getThread(id: string): Promise<ThreadRow | null> {
    const [row] = await db.select().from(analystThreads).where(eq(analystThreads.id, id)).limit(1);
    return row ? asThread(row) : null;
  }
  async listThreads(limit = 50): Promise<ThreadRow[]> {
    const rows = await db.select().from(analystThreads).where(eq(analystThreads.archived, false)).orderBy(desc(sql`coalesce(${analystThreads.lastTurnAt}, ${analystThreads.createdAt})`)).limit(limit);
    return rows.map(asThread);
  }
  async updateThread(id: string, patch: Partial<Pick<ThreadRow, 'title' | 'briefHash' | 'archived' | 'lastTurnAt'>>): Promise<void> {
    await db.update(analystThreads).set(patch).where(eq(analystThreads.id, id));
  }

  async appendMessages(threadId: string, rows: NewMessage[]): Promise<MessageRow[]> {
    if (rows.length === 0) return [];
    return db.transaction(async (tx) => {
      const [last] = await tx.select({ seq: analystMessages.seq }).from(analystMessages).where(eq(analystMessages.threadId, threadId)).orderBy(desc(analystMessages.seq)).limit(1);
      let seq = (last?.seq ?? 0) + 1;
      const inserted = await tx
        .insert(analystMessages)
        .values(rows.map((r) => ({ threadId, seq: seq++, turnId: r.turnId, role: r.role, apiJson: r.apiJson, display: r.display ?? null })))
        .returning();
      return inserted.map(asMessage);
    });
  }
  async listMessages(threadId: string): Promise<MessageRow[]> {
    const rows = await db.select().from(analystMessages).where(eq(analystMessages.threadId, threadId)).orderBy(asc(analystMessages.seq));
    return rows.map(asMessage);
  }

  async createTurn(t: { threadId: string; clientTurnId: string; question: string; kind: TurnKind; pageContext: Record<string, unknown> | null }): Promise<{ turn: TurnRow; created: boolean }> {
    const inserted = await db
      .insert(analystTurns)
      .values({ threadId: t.threadId, clientTurnId: t.clientTurnId, question: t.question, kind: t.kind, pageContext: t.pageContext })
      .onConflictDoNothing({ target: [analystTurns.threadId, analystTurns.clientTurnId] })
      .returning();
    if (inserted[0]) return { turn: asTurn(inserted[0]), created: true };
    const [existing] = await db.select().from(analystTurns).where(and(eq(analystTurns.threadId, t.threadId), eq(analystTurns.clientTurnId, t.clientTurnId))).limit(1);
    return { turn: asTurn(existing), created: false };
  }
  async getTurn(id: string): Promise<TurnRow | null> {
    const [row] = await db.select().from(analystTurns).where(eq(analystTurns.id, id)).limit(1);
    return row ? asTurn(row) : null;
  }
  async liveTurn(threadId: string): Promise<TurnRow | null> {
    const [row] = await db.select().from(analystTurns).where(and(eq(analystTurns.threadId, threadId), sql`${analystTurns.status} in ('running', 'needs_confirmation')`)).orderBy(desc(analystTurns.startedAt)).limit(1);
    return row ? asTurn(row) : null;
  }
  async updateTurn(id: string, patch: Partial<Pick<TurnRow, 'status' | 'rounds' | 'usage' | 'costUsd' | 'costEstimated' | 'error' | 'finishedAt' | 'stopRequested'>>): Promise<void> {
    await db.update(analystTurns).set({ ...patch, heartbeatAt: new Date() }).where(eq(analystTurns.id, id));
  }
  async appendEvent(turnId: string, event: Record<string, unknown>): Promise<number> {
    const [row] = await db
      .update(analystTurns)
      .set({ events: sql`${analystTurns.events} || ${JSON.stringify([event])}::jsonb`, heartbeatAt: new Date() })
      .where(eq(analystTurns.id, turnId))
      .returning({ events: analystTurns.events });
    return row?.events?.length ?? 0;
  }
  async heartbeat(turnId: string): Promise<void> {
    await db.update(analystTurns).set({ heartbeatAt: new Date() }).where(eq(analystTurns.id, turnId));
  }
  async spentUsdSince(since: Date): Promise<number> {
    const [row] = await db.select({ total: sql<number>`coalesce(sum(${analystTurns.costUsd}), 0)` }).from(analystTurns).where(gte(analystTurns.startedAt, since));
    return Number(row?.total ?? 0);
  }
  async sweepOrphans(olderThan: Date, reason: string): Promise<TurnRow[]> {
    const rows = await db
      .update(analystTurns)
      .set({ status: 'failed', error: reason, finishedAt: new Date() })
      .where(and(eq(analystTurns.status, 'running'), lt(analystTurns.heartbeatAt, olderThan)))
      .returning();
    return rows.map(asTurn);
  }
}

// ---------------------------------------------------------------------------
// Memory (smoke, eval, tests) — same semantics, nothing persisted
// ---------------------------------------------------------------------------

export class MemoryAnalystStore implements AnalystStore {
  threads = new Map<string, ThreadRow>();
  messages = new Map<string, MessageRow[]>();
  turns = new Map<string, TurnRow>();
  private id = 0;
  private next(prefix: string) {
    this.id += 1;
    return `${prefix}_${this.id}`;
  }
  async createThread(t: { model: AnalystModel; effort: Effort; answerMode: AnswerMode; briefHash: string | null; title?: string | null }): Promise<ThreadRow> {
    const row: ThreadRow = { id: this.next('thread'), title: t.title ?? null, model: t.model, effort: t.effort, answerMode: t.answerMode, briefHash: t.briefHash, archived: false, createdAt: new Date(), lastTurnAt: null };
    this.threads.set(row.id, row);
    this.messages.set(row.id, []);
    return row;
  }
  async getThread(id: string): Promise<ThreadRow | null> {
    return this.threads.get(id) ?? null;
  }
  async listThreads(limit = 50): Promise<ThreadRow[]> {
    return [...this.threads.values()].filter((t) => !t.archived).sort((a, b) => (b.lastTurnAt ?? b.createdAt).getTime() - (a.lastTurnAt ?? a.createdAt).getTime()).slice(0, limit);
  }
  async updateThread(id: string, patch: Partial<Pick<ThreadRow, 'title' | 'briefHash' | 'archived' | 'lastTurnAt'>>): Promise<void> {
    const t = this.threads.get(id);
    if (t) Object.assign(t, patch);
  }
  async appendMessages(threadId: string, rows: NewMessage[]): Promise<MessageRow[]> {
    const list = this.messages.get(threadId) ?? [];
    this.messages.set(threadId, list);
    let seq = (list[list.length - 1]?.seq ?? 0) + 1;
    const out = rows.map((r) => ({ id: this.next('msg'), threadId, seq: seq++, turnId: r.turnId, role: r.role, apiJson: r.apiJson, display: r.display ?? null, createdAt: new Date() }));
    list.push(...out);
    return out;
  }
  async listMessages(threadId: string): Promise<MessageRow[]> {
    return [...(this.messages.get(threadId) ?? [])];
  }
  async createTurn(t: { threadId: string; clientTurnId: string; question: string; kind: TurnKind; pageContext: Record<string, unknown> | null }): Promise<{ turn: TurnRow; created: boolean }> {
    const existing = [...this.turns.values()].find((x) => x.threadId === t.threadId && x.clientTurnId === t.clientTurnId);
    if (existing) return { turn: existing, created: false };
    const row: TurnRow = { id: this.next('turn'), threadId: t.threadId, clientTurnId: t.clientTurnId, status: 'running', question: t.question, kind: t.kind, pageContext: t.pageContext, events: [], heartbeatAt: new Date(), stopRequested: false, rounds: 0, usage: null, costUsd: 0, costEstimated: false, error: null, startedAt: new Date(), finishedAt: null };
    this.turns.set(row.id, row);
    return { turn: row, created: true };
  }
  async getTurn(id: string): Promise<TurnRow | null> {
    return this.turns.get(id) ?? null;
  }
  async liveTurn(threadId: string): Promise<TurnRow | null> {
    return [...this.turns.values()].filter((t) => t.threadId === threadId && (t.status === 'running' || t.status === 'needs_confirmation')).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
  }
  async updateTurn(id: string, patch: Partial<Pick<TurnRow, 'status' | 'rounds' | 'usage' | 'costUsd' | 'costEstimated' | 'error' | 'finishedAt' | 'stopRequested'>>): Promise<void> {
    const t = this.turns.get(id);
    if (t) Object.assign(t, patch, { heartbeatAt: new Date() });
  }
  async appendEvent(turnId: string, event: Record<string, unknown>): Promise<number> {
    const t = this.turns.get(turnId);
    if (!t) return 0;
    t.events = [...t.events, event];
    t.heartbeatAt = new Date();
    return t.events.length;
  }
  async heartbeat(turnId: string): Promise<void> {
    const t = this.turns.get(turnId);
    if (t) t.heartbeatAt = new Date();
  }
  async spentUsdSince(since: Date): Promise<number> {
    return [...this.turns.values()].filter((t) => t.startedAt >= since).reduce((a, t) => a + t.costUsd, 0);
  }
  async sweepOrphans(olderThan: Date, reason: string): Promise<TurnRow[]> {
    const out: TurnRow[] = [];
    for (const t of this.turns.values()) {
      if (t.status === 'running' && t.heartbeatAt < olderThan) {
        Object.assign(t, { status: 'failed', error: reason, finishedAt: new Date() });
        out.push(t);
      }
    }
    return out;
  }
}

/** Shared for the routes; tests and the smoke pass their own. */
let defaultStore: AnalystStore | null = null;
export function analystStore(): AnalystStore {
  if (!defaultStore) defaultStore = new DbAnalystStore();
  return defaultStore;
}

/** For tests: the latest events after `after` (0-based count). */
export function eventsAfter(turn: TurnRow, after: number): Array<Record<string, unknown>> {
  return turn.events.slice(Math.max(0, after));
}

