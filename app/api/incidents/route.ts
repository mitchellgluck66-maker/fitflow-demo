import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';

export const dynamic = 'force-dynamic';

/** GET ?resolved=1 — incidents (open by default; resolved=1 lists the last 50 resolved). */
export async function GET(request: NextRequest) {
  try {
    const resolved = request.nextUrl.searchParams.get('resolved') === '1';
    const rows = await db
      .select()
      .from(syncIncidents)
      .where(resolved ? undefined : isNull(syncIncidents.resolvedAt))
      .orderBy(desc(syncIncidents.createdAt))
      .limit(resolved ? 50 : 100);
    return NextResponse.json({
      incidents: rows
        .filter((r) => (resolved ? r.resolvedAt !== null : true))
        .map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to list incidents', detail: String(error) }, { status: 500 });
  }
}

/** PATCH {id, resolved?: boolean} — mark an incident resolved (or reopen). */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 });
    const resolved = body.resolved !== false;
    const [row] = await db
      .update(syncIncidents)
      .set({ resolvedAt: resolved ? new Date() : null })
      .where(eq(syncIncidents.id, body.id))
      .returning({ id: syncIncidents.id, resolvedAt: syncIncidents.resolvedAt });
    if (!row) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    return NextResponse.json({ ok: true, id: row.id, resolvedAt: row.resolvedAt?.toISOString() ?? null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update incident', detail: String(error) }, { status: 500 });
  }
}
