import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { getOwnerProfile, parseOwnerProfile, profileGaps, saveOwnerProfile, withheldLine } from '@/lib/analyst/notes';
import { rebuildBrief } from '@/lib/analyst/briefService';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET() {
  try {
    const profile = await getOwnerProfile();
    const gaps = profileGaps(profile);
    return NextResponse.json({ profile, gaps, withheld: withheldLine(gaps) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the owner profile');
  }
}

/** PUT { profile } — save and rebuild the brief (the profile is part of it). */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { profile?: unknown };
    const profile = parseOwnerProfile(JSON.stringify(body.profile ?? {}));
    await saveOwnerProfile(profile);
    const gaps = profileGaps(profile);
    let rebuilt = true;
    let error: string | undefined;
    try {
      await rebuildBrief({ trigger: 'notes' });
    } catch (e) {
      rebuilt = false;
      error = `Brief rebuild failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    return NextResponse.json({ ok: true, profile, gaps, withheld: withheldLine(gaps), rebuilt, ...(error ? { error } : {}) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to save the owner profile');
  }
}
