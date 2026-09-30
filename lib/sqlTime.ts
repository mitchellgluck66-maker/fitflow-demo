/**
 * Timestamp PARAMS for comparisons against a raw sql`` expression (2026-09-30 — stripe_completeness crashed on its
 * first scheduled run: `invalid input syntax for type timestamp with time zone: "Mon Jun 01 2026 06:00:00 GMT+0000
 * (Coordinated Universal Time)"`, Postgres 22007).
 *
 * Why a raw Date breaks: drizzle encodes a Date only through a TYPED column (PgTimestamp.mapToDriverValue →
 * toISOString). Compared with a raw sql`coalesce(...)` there is no column, so the Date reaches postgres-js as-is;
 * postgres-js infers it as timestamptz (oid 1184), drizzle's postgres-js driver makes that serializer transparent,
 * and the wire write does `'' + date` → Date.toString(). PGlite's driver serializes Dates itself, so the test suite
 * never saw it. tests/sql-date-params.test.ts replays the postgres-js wire rule on real Postgres (PGlite) and guards
 * the source against the shape coming back.
 *
 * Rule: a Date compared with anything that is not a typed timestamp column goes through tsParam — an ISO string with
 * an explicit ::timestamptz cast, whatever the driver.
 */
import { sql, type SQL } from 'drizzle-orm';

export function tsParam(d: Date): SQL {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RangeError(`tsParam: not a valid date (${String(d)})`);
  return sql`${d.toISOString()}::timestamptz`;
}

/** A YYYY-MM-DD query value as the instant `T${time}Z`, or a named RangeError — never "Invalid Date" sent to Postgres. */
export function isoDayParam(day: string, time: '00:00:00' | '23:59:59.999', name: string): SQL {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`${name} must be a date as YYYY-MM-DD (got "${day}")`);
  return tsParam(new Date(`${day}T${time}Z`));
}
