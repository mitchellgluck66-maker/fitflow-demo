import { NextResponse } from 'next/server';
import { versionInfo } from '@/lib/version';

export const dynamic = 'force-dynamic';

/** GET /api/version — { commit, builtAt } of the running build (lib/version.ts). Exempt from auth: no data behind it. */
export async function GET() {
  return NextResponse.json(versionInfo(), { headers: { 'Cache-Control': 'no-store' } });
}
