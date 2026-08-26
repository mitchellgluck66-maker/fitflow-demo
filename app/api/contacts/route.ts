import { NextRequest, NextResponse } from 'next/server';
import { inArray, eq } from 'drizzle-orm';
import { db, contacts, stages } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/contacts?ids=a,b,c — the actual people behind a funnel bar.
 * Read-only; capped at 500 ids.
 */
export async function GET(request: NextRequest) {
  try {
    const ids = (request.nextUrl.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);
    if (ids.length === 0) return NextResponse.json({ people: [] });

    const rows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        source: contacts.attributionSource,
        owner: contacts.ownerName,
        stage: stages.name,
        role: stages.semanticRole,
        appliedAt: contacts.ghlCreatedAt,
        origin: contacts.origin,
        ghlContactId: contacts.ghlContactId,
      })
      .from(contacts)
      .leftJoin(stages, eq(contacts.stageId, stages.id))
      .where(inArray(contacts.id, ids));

    const order = new Map(ids.map((id, i) => [id, i]));
    return NextResponse.json({
      people: rows
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map((r) => ({
          ...r,
          name: `${r.firstName} ${r.lastName}`.trim() || r.email || 'Unknown',
          appliedAt: r.appliedAt?.toISOString() ?? null,
        })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load contacts', detail: String(error) }, { status: 500 });
  }
}
