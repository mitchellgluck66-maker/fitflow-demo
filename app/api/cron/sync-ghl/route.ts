import { NextRequest, NextResponse } from 'next/server';
import { runGhlSync } from '@/lib/ghl/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/sync-ghl — hourly GHL delta sync (vercel.json).
 *
 * Vercel invokes cron routes with `Authorization: Bearer $CRON_SECRET`. We
 * require it in production so nobody can trigger syncs from outside; locally
 * (no CRON_SECRET set) the route is open for `curl` testing.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }

  const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
