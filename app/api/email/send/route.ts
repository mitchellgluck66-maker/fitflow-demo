import { NextRequest, NextResponse } from 'next/server';
import { runDigest } from '@/lib/email/send';
import { isDigestKind } from '@/lib/email/digests';

export const dynamic = 'force-dynamic';

/** POST /api/email/send {kind} — manual "Send now" (forces even when empty / already sent). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!isDigestKind(body.kind)) return NextResponse.json({ error: 'kind must be daily_todo, weekly or monthly' }, { status: 400 });
    const result = await runDigest(body.kind, { force: true });
    return NextResponse.json({ ok: result.status === 'sent' || result.status === 'stored', ...result });
  } catch (error) {
    return NextResponse.json({ error: 'Send failed', detail: String(error) }, { status: 500 });
  }
}
