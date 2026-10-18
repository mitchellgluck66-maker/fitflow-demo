import { NextRequest, NextResponse } from 'next/server';
import { companionPreview } from '@/lib/companion/preview';

export const dynamic = 'force-dynamic';

/**
 * GET /api/companion/preview?state=confirm|success|partial|dryrun — canned log-panel states for the screenshots.
 * Exists ONLY with COMPANION_PREVIEW=1 outside production (404 otherwise): never a production surface, demo names only.
 */
export async function GET(request: NextRequest) {
  if (process.env.COMPANION_PREVIEW !== '1' || process.env.NODE_ENV === 'production' || process.env.VERCEL) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const p = companionPreview(request.nextUrl.searchParams.get('state') ?? '');
  if (!p) return NextResponse.json({ error: 'Unknown preview state' }, { status: 400 });
  return NextResponse.json(p);
}
