import { NextRequest, NextResponse } from 'next/server';
import { ilike, or, eq, sql } from 'drizzle-orm';
import { db, contacts, stages } from '@/db';

export const dynamic = 'force-dynamic';

/** GET /api/contacts/search?q= — name/email search for the manual-match picker (≤20). */
export async function GET(request: NextRequest) {
  try {
    const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return NextResponse.json({ people: [] });
    const pattern = `%${q}%`;
    const rows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        source: contacts.attributionSource,
        stage: stages.name,
      })
      .from(contacts)
      .leftJoin(stages, eq(contacts.stageId, stages.id))
      .where(
        or(
          ilike(contacts.email, pattern),
          ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, pattern),
        ),
      )
      .limit(20);
    return NextResponse.json({
      people: rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`.trim() || r.email || 'Unknown', email: r.email, source: r.source, stage: r.stage })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Search failed', detail: String(error) }, { status: 500 });
  }
}
