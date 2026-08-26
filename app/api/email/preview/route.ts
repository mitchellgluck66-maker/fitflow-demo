import { NextRequest, NextResponse } from 'next/server';
import { buildDigest, isDigestKind } from '@/lib/email/digests';

export const dynamic = 'force-dynamic';

/** GET /api/email/preview?kind=daily_todo|weekly|monthly[&today=YYYY-MM-DD] — render only. */
export async function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get('kind') ?? 'daily_todo';
  if (!isDigestKind(kind)) return NextResponse.json({ error: 'kind must be daily_todo, weekly or monthly' }, { status: 400 });
  const today = request.nextUrl.searchParams.get('today') ?? undefined;
  try {
    const digest = await buildDigest(kind, today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined);
    if (request.nextUrl.searchParams.get('format') === 'text') {
      return new NextResponse(digest.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new NextResponse(digest.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Digest-Empty': String(digest.empty) } });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to render digest', detail: String(error) }, { status: 500 });
  }
}
