import { NextRequest, NextResponse } from 'next/server';
import { runReport } from '@/lib/reports/run';
import { reportKindOf } from '@/lib/reports/kinds';

export const dynamic = 'force-dynamic';

/** POST /api/email/send {kind} — manual "Send now" for the latest period (forces even when empty / already sent). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const kind = reportKindOf(body.kind);
    if (!kind) return NextResponse.json({ error: 'kind must be daily, weekly or monthly' }, { status: 400 });
    const result = await runReport(kind, { force: true });
    return NextResponse.json({ ok: result.status === 'sent' || result.status === 'stored', ...result });
  } catch (error) {
    return NextResponse.json({ error: 'Send failed', detail: String(error) }, { status: 500 });
  }
}
