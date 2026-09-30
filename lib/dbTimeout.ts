/**
 * Bounded waits for the API layer (2026-09-30, audit P1 #1).
 *
 * A route that awaits a query with no bound hangs until Vercel kills the function at 300 s and the
 * browser sees "Failed to fetch" with no error to show. Wrap the route's data work in `dbTimeout`:
 * past the budget it throws `DbTimeoutError`, the pool is reset (a dead socket is the usual cause —
 * see db/index.ts) and `apiErrorResponse` turns it into a 504 JSON the UI can show with Retry.
 */
import { NextResponse } from 'next/server';
import { resetDbConnection } from '@/db';

export const DB_TIMEOUT_MS = 30_000;

export class DbTimeoutError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`The database did not answer within ${Math.round(ms / 1000)} s (${label}) — the connection was reset; try again`);
    this.name = 'DbTimeoutError';
    this.label = label;
    this.ms = ms;
  }
}

export async function dbTimeout<T>(work: Promise<T>, label: string, ms = DB_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DbTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([work, bound]);
  } catch (error) {
    if (error instanceof DbTimeoutError) await resetDbConnection(error.message);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The JSON error a route returns: 504 for a timed-out query, 400 for a caller's RangeError, else 500. */
export function apiErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof DbTimeoutError) return NextResponse.json({ error: error.message, timeout: true }, { status: 504 });
  if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ error: fallback, detail: describeError(error) }, { status: 500 });
}

/** The cause, not the query text: drizzle wraps a failed statement as "Failed query: select … params: …" with the driver error in `cause`. */
export function describeError(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith('Failed query:') ? 'the database query failed' : text;
}
