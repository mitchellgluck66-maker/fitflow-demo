/**
 * Database connection.
 *
 *   DATABASE_URL set   → Supabase Postgres via postgres-js (production, Vercel).
 *   DATABASE_URL unset → embedded PGlite Postgres in ./db/pglite (local dev,
 *                        tests). Same dialect, same migrations, zero infra.
 *
 * Both paths expose the identical Drizzle API so nothing above this file knows
 * which one it is talking to.
 */

import path from 'path';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

declare global {
  var __fitflowDb: Db | undefined;
  var __fitflowPg: ReturnType<typeof postgres> | undefined;
}

// CLI scripts (tsx) do not load .env.local the way Next does. Load it here so
// `npm run db:seed` and the app can never point at different databases.
if (
  !process.env.NEXT_RUNTIME &&
  !process.env.VITEST &&
  !process.env.PGLITE_DATA_DIR &&
  process.env.DATABASE_URL === undefined &&
  typeof process.loadEnvFile === 'function'
) {
  try {
    process.loadEnvFile(path.join(process.cwd(), '.env.local'));
  } catch {
    /* no .env.local — embedded PGlite */
  }
}

export const DATABASE_URL = process.env.DATABASE_URL?.trim() || null;
export const isEmbeddedDb = !DATABASE_URL;

function createDb(): Db {
  if (DATABASE_URL) {
    // Supabase's transaction pooler (port 6543) does not support prepared
    // statements; prepare:false is safe on the session pooler too.
    //
    // 2026-09-30 (audit P1 #1): on Vercel, /api/clients, /api/currency and /api/settings hung until the
    // 300 s function timeout while Postgres showed NO running query — the warm function was reusing a
    // socket that had died while the function was frozen, so the query was written into the void.
    // Connections now close after 20 s idle (nothing survives a freeze), live at most 15 min, and a
    // connect attempt gives up after 10 s. `lib/dbTimeout.ts` bounds every route's wait and resets this
    // pool when it trips, so the next request gets a fresh socket instead of the dead one.
    const client = postgres(DATABASE_URL, { prepare: false, max: 5, idle_timeout: 20, max_lifetime: 60 * 15, connect_timeout: 10 });
    globalThis.__fitflowPg = client;
    return drizzlePostgres(client, { schema }) as unknown as Db;
  }

  const dataDir =
    process.env.PGLITE_DATA_DIR === 'memory'
      ? undefined
      : process.env.PGLITE_DATA_DIR || path.join(process.cwd(), 'db', 'pglite');
  const client = new PGlite(dataDir);
  return drizzlePglite(client, { schema }) as unknown as Db;
}

function getDb(): Db {
  // Cached on globalThis so Next's dev hot-reload does not open a new PGlite
  // handle (or a new Postgres pool) on every module re-evaluation.
  if (!globalThis.__fitflowDb) globalThis.__fitflowDb = createDb();
  return globalThis.__fitflowDb;
}

/**
 * Drop the Postgres pool so the next query opens fresh connections. Called when a query did not answer
 * within `lib/dbTimeout`'s budget (a dead socket); a no-op on PGlite. Ending the old client is best
 * effort and never awaited past a second — its sockets may be the very ones that are dead.
 */
export async function resetDbConnection(reason: string): Promise<void> {
  const pg = globalThis.__fitflowPg;
  if (!pg) return;
  globalThis.__fitflowPg = undefined;
  globalThis.__fitflowDb = undefined;
  console.warn(`[db] resetting the Postgres pool: ${reason}`);
  try {
    await pg.end({ timeout: 1 });
  } catch {
    /* the pool was already unusable */
  }
}

/**
 * Lazy handle: the connection is opened on first use, not on import. `next
 * build` imports every route module in parallel workers; opening PGlite in
 * each of them at import time races on the data directory.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export {
  pipelines,
  stages,
  contacts,
  appointments,
  stageTransitions,
  stageSnapshots,
  adSpend,
  payments,
  emailDigests,
  aiReports,
  syncRuns,
  syncIncidents,
  settings,
  ghlSyncQueue,
  fxRates,
  syncLocks,
  ghlOpportunities,
  analystBriefs,
  analystNotes,
  analystThreads,
  analystTurns,
  analystMessages,
  appliedLedger,
  appliedRatioDaily,
  SEMANTIC_ROLES,
} from './schema';
export type {
  SemanticRole,
  Origin,
  PaymentClass,
  AttributionClass,
  Pipeline,
  NewPipeline,
  Stage,
  NewStage,
  Contact,
  NewContact,
  Appointment,
  NewAppointment,
  StageTransition,
  NewStageTransition,
  StageSnapshot,
  AdSpend,
  Payment,
  EmailDigest,
  AiReport,
  SyncRun,
  NewSyncRun,
  SyncIncident,
  Setting,
  GhlSyncQueueItem,
  FxRateRow,
} from './schema';
