import { NextRequest } from 'next/server';
import { handleDigestCron } from '@/lib/email/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET /api/cron/monthly-scorecard — sends from 6am local (lib/email/cron#inSendWindow; once per period). ?force=1 for manual runs. */
export function GET(request: NextRequest) {
  return handleDigestCron(request, 'monthly');
}
