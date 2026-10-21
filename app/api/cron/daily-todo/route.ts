import { NextRequest } from 'next/server';
import { handleDigestCron } from '@/lib/email/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET /api/cron/daily-todo — sends on the first run after 00:00 business time for the period that just ended (lib/email/schedule; once per period). ?force=1 for manual runs. */
export function GET(request: NextRequest) {
  return handleDigestCron(request, 'daily_todo');
}
