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
    const client = postgres(DATABASE_URL, { prepare: false, max: 5 });
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
} from './schema';
