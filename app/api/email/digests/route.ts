import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, emailDigests } from '@/db';

export const dynamic = 'force-dynamic';

/** GET /api/email/digests — archive list; ?id= returns one digest with its html. */
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (id) {
      const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, id)).limit(1);
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ ...row, sentAt: row.sentAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() });
    }
    const rows = await db
      .select({
        id: emailDigests.id,
        kind: emailDigests.kind,
        periodStart: emailDigests.periodStart,
        periodEnd: emailDigests.periodEnd,
        recipients: emailDigests.recipients,
        subject: emailDigests.subject,
        status: emailDigests.status,
        error: emailDigests.error,
        sentAt: emailDigests.sentAt,
        createdAt: emailDigests.createdAt,
      })
      .from(emailDigests)
      .orderBy(desc(emailDigests.createdAt))
      .limit(200);
    return NextResponse.json({
      digests: rows.map((r) => ({ ...r, sentAt: r.sentAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to list digests', detail: String(error) }, { status: 500 });
  }
}
