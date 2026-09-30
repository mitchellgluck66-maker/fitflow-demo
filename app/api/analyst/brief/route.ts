import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { getTimezone } from '@/lib/settings';
import { currentBrief, describeBrief, rebuildBrief } from '@/lib/analyst/briefService';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET — the current brief's status line (never its text: that is the model's, not the browser's). */
export async function GET() {
  try {
    const [brief, timezone] = await Promise.all([currentBrief(), getTimezone()]);
    return NextResponse.json({
      built: Boolean(brief),
      summary: describeBrief(brief, timezone),
      hash: brief?.hash ?? null,
      tokens: brief?.tokens ?? null,
      dataThrough: brief?.dataThrough ?? null,
      builtAt: brief?.builtAt.toISOString() ?? null,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the brief');
  }
}

/** POST — "Rebuild now". A build error leaves the previous brief and returns its reason (500). */
export async function POST() {
  try {
    const result = await rebuildBrief({ trigger: 'manual' });
    const [brief, timezone] = await Promise.all([currentBrief(), getTimezone()]);
    return NextResponse.json({ ...result, summary: describeBrief(brief, timezone) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: `Brief build failed: ${error instanceof Error ? error.message : String(error)} — the previous brief is still in use` }, { status: 500 });
  }
}
