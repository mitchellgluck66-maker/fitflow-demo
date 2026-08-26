import { NextResponse } from 'next/server';
import { db, isEmbeddedDb } from '@/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/** GET /api/health — DB reachability for Vercel checks. */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, database: isEmbeddedDb ? 'pglite (embedded)' : 'postgres' });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
