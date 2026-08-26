import { NextRequest } from 'next/server';
import { handleDigestCron } from '@/lib/email/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET /api/cron/daily-todo — 7am local (vercel.json fires 11 + 12 UTC). ?force=1 for manual runs. */
export function GET(request: NextRequest) {
  return handleDigestCron(request, 'daily_todo');
}
