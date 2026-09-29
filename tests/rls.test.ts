/**
 * C2 — row-level security, deny-all (migration 0009).
 *
 * Two halves, both required:
 *   1. The PostgREST side door is shut: a non-owner role holding Supabase's
 *      default `anon` grants (SELECT on every public table) sees ZERO rows.
 *   2. The app still reads: it connects as the table owner, which bypasses
 *      RLS because FORCE is deliberately not set.
 * Plus the guardrail: every public table has RLS on, none has a policy —
 * a future migration that forgets `ENABLE ROW LEVEL SECURITY` fails here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, settings, payments } from '@/db';
import { getSetting, setSetting } from '@/lib/settings';

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> => {
  const res = (await db.execute(q)) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(res) ? res : (res.rows ?? []);
};

beforeAll(async () => {
  await runMigrations();
  await setSetting('ghl_token', 'pit-secret-value', { secret: true });
  await db.insert(payments).values({ stripeId: 'ch_rls', kind: 'charge', status: 'succeeded', amountCents: 1_000, currency: 'CAD', source: 'stripe', origin: 'stripe' });
  // Supabase grants the API roles SELECT/INSERT/UPDATE/DELETE on public tables by default.
  await db.execute(sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$`);
  await db.execute(sql`GRANT USAGE ON SCHEMA public TO anon`);
  await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon`);
});

describe('RLS deny-all on every public table', () => {
  it('every public table has RLS enabled, not forced, and no policies', async () => {
    const tables = await rows(sql`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    expect(tables.length).toBeGreaterThanOrEqual(15);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => t.forced).map((t) => t.name)).toEqual([]);
    const policies = await rows(sql`SELECT policyname FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies).toEqual([]);
  });

  it('the API role (anon) reads nothing — not settings, not payments', async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE anon`);
      const s = (await tx.execute(sql`SELECT count(*)::int AS n FROM settings`)) as unknown as { rows?: Row[] } | Row[];
      const p = (await tx.execute(sql`SELECT count(*)::int AS n FROM payments`)) as unknown as { rows?: Row[] } | Row[];
      const first = (r: { rows?: Row[] } | Row[]) => (Array.isArray(r) ? r[0] : r.rows?.[0]);
      return { settings: Number(first(s)?.n), payments: Number(first(p)?.n) };
    });
    expect(seen).toEqual({ settings: 0, payments: 0 });
  });

  it('the app (table owner) still reads and writes after the migration', async () => {
    expect(await getSetting('ghl_token')).toBe('pit-secret-value');
    const p = await db.select({ id: payments.stripeId }).from(payments);
    expect(p.map((r) => r.id)).toContain('ch_rls');
    await setSetting('timezone', 'America/Edmonton');
    expect((await db.select().from(settings)).some((r) => r.key === 'timezone')).toBe(true);
  });
});
