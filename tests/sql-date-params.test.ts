/**
 * 2026-09-30 — stripe_completeness crashed on its FIRST scheduled run (Postgres 22007: invalid input syntax for type
 * timestamp with time zone: "Mon Jun 01 2026 06:00:00 GMT+0000 (Coordinated Universal Time)").
 *
 * The class: a JS Date compared with a raw sql`` expression has no column to encode it. drizzle's postgres-js driver makes
 * the timestamptz serializer transparent, and postgres-js writes the bind value as `'' + x` → Date.toString(). PGlite's
 * driver serializes Dates itself, so every DB test passed. These tests:
 *   1 · GUARD — the real queries' params are ISO strings, never a Date and never Date.toString() (and the guard trips on
 *       the pre-fix shape);
 *   2 · REAL POSTGRES — the completeness and /clients queries run on Postgres (PGlite is the real engine) with the params
 *       written exactly as postgres-js-under-drizzle writes them; the pre-fix shape is replayed and must fail with 22007;
 *   3 · SOURCE — no comparison against a raw sql`` expression (or a variable holding one) takes a bare Date again.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { and, count, gte, lt, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, payments, contacts } from '@/db';
import { tsParam, isoDayParam } from '@/lib/sqlTime';
import { mirrorBookQuery } from '@/lib/stripe/completeness';
import { appliedRangeConditions, listClients } from '@/lib/queries/clients';
import { upsertCharges } from '@/lib/stripe/ingest';
import { GET as clientsGet } from '@/app/api/clients/route';

const ROOT = path.resolve(__dirname, '..');
const dialect = new PgDialect();
const TZ = 'America/Edmonton';

// ---- postgres-js under drizzle, the wire rule (node_modules/postgres/cjs/src/connection.js Bind + drizzle-orm/postgres-js/driver.js) ----
// A Date is inferred as timestamptz (1184); drizzle makes that serializer transparent; Bind writes `'' + x`. Strings go as-is.
function postgresJsWire(params: unknown[]): Array<string | null> {
  return params.map((x) => (x === null || x === undefined ? null : x instanceof Date ? '' + x : typeof x === 'string' ? x : typeof x === 'number' ? String(x) : JSON.stringify(x)));
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
function assertIsoParams(params: unknown[], where: string) {
  params.forEach((p, i) => {
    if (p instanceof Date) throw new Error(`${where}: param ${i + 1} is a raw Date — postgres-js would send "${String(p)}" (use lib/sqlTime#tsParam)`);
    if (typeof p === 'string' && /GMT[+-]\d{4}|\(.+ Time\)$/.test(p)) throw new Error(`${where}: param ${i + 1} is Date.toString() text: "${p}"`);
    if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p) && !ISO.test(p)) throw new Error(`${where}: param ${i + 1} is not ISO-8601: "${p}"`);
  });
}
type Raw = { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
const pg = () => (db as unknown as { $client: Raw }).$client;

const noonUtc = (d: string) => Math.floor(Date.parse(`${d}T18:00:00Z`) / 1000);
const charge = (id: string, day: string) => ({ id, object: 'charge', amount: 50_000, amount_refunded: 0, currency: 'cad', status: 'succeeded', created: noonUtc(day), refunded: false, customer: null, billing_details: {}, invoice: null });
const prov = { source: 'ghl', origin: 'ghl', syncedAt: new Date(), backfilled: false } as const;

beforeAll(async () => {
  await runMigrations();
  // the Sep 2–11 shape: one charge a day
  const days = Array.from({ length: 10 }, (_, i) => `2026-09-${String(2 + i).padStart(2, '0')}`);
  await upsertCharges(days.map((d) => charge(`ch_${d}`, d)) as never, { syncedAt: new Date('2026-09-30T18:00:00Z'), backfilled: false } as never);
  await db.insert(contacts).values([
    { ghlContactId: 'ct-a', firstName: 'Riley', lastName: 'Fixture', email: 'riley@example.test', ghlCreatedAt: new Date('2026-09-05T15:00:00Z'), ...prov },
    { ghlContactId: 'ct-b', firstName: 'Jordan', lastName: 'Sample', email: 'jordan@example.test', ghlCreatedAt: new Date('2026-08-01T15:00:00Z'), ...prov },
  ]);
});

describe('1 · the guard: timestamp params are ISO strings, never a Date or Date.toString()', () => {
  it('tsParam: an ISO string with an explicit ::timestamptz cast; an invalid date is a named RangeError', () => {
    const q = dialect.sqlToQuery(gte(sql`now()`, tsParam(new Date('2026-06-01T06:00:00Z'))));
    expect(q.params).toEqual(['2026-06-01T06:00:00.000Z']);
    expect(q.sql).toContain('::timestamptz');
    expect(() => tsParam(new Date('nope'))).toThrow(RangeError);
    expect(() => isoDayParam('09/01/2026', '00:00:00', 'from')).toThrow('from must be a date as YYYY-MM-DD (got "09/01/2026")');
  });
  it('the completeness query (lib/stripe/completeness#mirrorBookQuery) sends ISO bounds', () => {
    const q = mirrorBookQuery(Date.parse('2026-06-01T06:00:00Z'), Date.parse('2026-07-01T06:00:00Z'), TZ).toSQL();
    assertIsoParams(q.params, 'mirrorBookQuery');
    expect(q.params).toContain('2026-06-01T06:00:00.000Z');
    expect(q.params).toContain('2026-07-01T06:00:00.000Z');
  });
  it('the /clients Applied range (lib/queries/clients#appliedRangeConditions) sends ISO bounds', () => {
    const q = dialect.sqlToQuery(and(...appliedRangeConditions({ from: '2026-09-01', to: '2026-09-30' }))!);
    assertIsoParams(q.params, 'appliedRangeConditions');
    expect(q.params).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z']);
  });
  it('the guard trips on the pre-fix shape (a bare Date against a raw coalesce)', () => {
    const q = dialect.sqlToQuery(gte(sql`coalesce(${payments.stripeCreatedAt}, ${payments.paidAt})`, new Date('2026-06-01T06:00:00Z')));
    expect(() => assertIsoParams(q.params, 'pre-fix')).toThrow(/raw Date/);
  });
});

describe('2 · real Postgres semantics: the params exactly as postgres-js-under-drizzle writes them', () => {
  it('drizzle still makes timestamptz (1184) transparent — the premise of the wire rule', () => {
    const src = fs.readFileSync(path.join(ROOT, 'node_modules/drizzle-orm/postgres-js/driver.js'), 'utf8');
    expect(src).toMatch(/for \(const type of \[[^\]]*"1184"[^\]]*\]\)[\s\S]{0,120}client\.options\.serializers\[type\] = transparentParser/);
  });
  it('the PRE-FIX completeness query is refused by Postgres with 22007 — the production failure, reproduced (Vercel runs in UTC)', async () => {
    const tz = process.env.TZ; process.env.TZ = 'UTC';   // Date.toString() as the production process renders it
    try {
      const at = sql`coalesce(${payments.stripeCreatedAt}, ${payments.paidAt}, ${payments.failedAt})`;
      const q = db.select({ n: count() }).from(payments).where(and(gte(at, new Date(Date.parse('2026-06-01T06:00:00Z'))), lt(at, new Date(Date.parse('2026-10-01T06:00:00Z'))))).toSQL();
      const wire = postgresJsWire(q.params);
      expect(wire[0]).toBe('Mon Jun 01 2026 06:00:00 GMT+0000 (Coordinated Universal Time)');   // the value in the production error, byte for byte
      await expect(pg().query(q.sql, wire)).rejects.toMatchObject({ code: '22007', message: expect.stringMatching(/invalid input syntax for type timestamp with time zone/) });
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  });
  it('the FIXED completeness query runs on Postgres and buckets the Sep 2–11 charges by Edmonton day', async () => {
    const q = mirrorBookQuery(Date.parse('2026-09-01T06:00:00Z'), Date.parse('2026-09-15T06:00:00Z'), TZ).toSQL();
    const r = await pg().query(q.sql, postgresJsWire(q.params));
    const days = r.rows.map((x) => String(Object.values(x)[0])).sort();
    expect(days).toEqual(Array.from({ length: 10 }, (_, i) => `2026-09-${String(2 + i).padStart(2, '0')}`));
    expect(r.rows.every((x) => Number(Object.values(x)[2]) === 1)).toBe(true);
  });
  it('the /clients Applied filter runs on Postgres and returns the row in range (and not the one outside it)', async () => {
    const q = db.select({ id: contacts.ghlContactId }).from(contacts).where(and(...appliedRangeConditions({ from: '2026-09-01', to: '2026-09-30' }))).toSQL();
    const r = await pg().query(q.sql, postgresJsWire(q.params));
    expect(r.rows.map((x) => Object.values(x)[0])).toEqual(['ct-a']);
  });
});

describe('/clients through the app', () => {
  it('listClients with a date range returns rows', async () => {
    const res = await listClients({ from: '2026-09-01', to: '2026-09-30' });
    expect(res.total).toBe(1);
    expect(res.rows.length).toBe(1);
  });
  it('a malformed date is a 400 that names the field — never a 500, never "Invalid Date" sent to Postgres', async () => {
    const res = await clientsGet(new NextRequest('http://x/api/clients?from=09%2F01%2F2026'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('from must be a date as YYYY-MM-DD (got "09/01/2026")');
  });
});

describe('3 · the source: no bare Date against a raw sql`` expression, anywhere', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { if (['node_modules', '.next', '_to_delete', '.git'].includes(f)) continue; const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p); } };
  for (const d of ['lib', 'app', 'scripts', 'db', 'hooks', 'components']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  it('every gte/lte/gt/lt/eq/ne/between whose left side is a sql`` expression or a variable takes its date through tsParam', () => {
    const bad: string[] = [];
    const CALL = /\b(gte|lte|gt|lt|eq|ne|between|notBetween)\(\s*(sql(?:<[^>`]*>)?`[^`]*`|[A-Za-z_$][\w$]*)\s*,\s*([^,)]*(?:\([^)]*\))?)/g;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const right = m[3].trim();
        if (/^(tsParam|isoDayParam)\(/.test(right)) continue;
        if (/new Date\(/.test(right) || /^[A-Za-z_$][\w$]*(Date|At|Ms|Start|End|Since|Until|Cutoff)$/.test(right) || /^(date|start|end|since|until|cutoff|from|to|now)$/i.test(right)) {
          bad.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length}  ${m[0].slice(0, 120)}`);
        }
      }
    }
    expect(bad, 'a Date compared with a raw sql`` expression goes through lib/sqlTime#tsParam:\n' + bad.join('\n')).toEqual([]);
  });
  it('no sql`` template interpolates a Date directly', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/sql(?:<[^>`]*>)?`((?:[^`\\]|\\.)*)`/g)) for (const x of m[1].matchAll(/\$\{([^}]*)\}/g)) if (/new Date\(/.test(x[1]) && !/toISOString\(\)/.test(x[1])) bad.push(`${path.relative(ROOT, f)}: \${${x[1]}}`);
    }
    expect(bad).toEqual([]);
  });
});
