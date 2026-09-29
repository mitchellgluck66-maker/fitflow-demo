import { NextResponse } from 'next/server';
import { getTimezone } from '@/lib/settings';
import { assessMetaToken, readMetaTokenStatus, runMetaTokenCheck } from '@/lib/meta/token';

export const dynamic = 'force-dynamic';

/** GET /api/meta/token — the last stored self-check (no Meta call). */
export async function GET() {
  try {
    const status = await readMetaTokenStatus();
    return NextResponse.json({ status, assessment: status ? assessMetaToken(status, Date.now(), await getTimezone()) : null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read the Meta token status', detail: String(error) }, { status: 500 });
  }
}

/** POST /api/meta/token — Setup → Sync health "Check now": one debug_token GET. */
export async function POST() {
  try {
    const r = await runMetaTokenCheck();
    return NextResponse.json({ ok: r.ok, notConfigured: r.notConfigured ?? false, error: r.error ?? null, status: r.status ?? null, assessment: r.assessment ?? null });
  } catch (error) {
    return NextResponse.json({ error: 'Meta token check failed', detail: String(error) }, { status: 500 });
  }
}
