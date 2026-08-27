import { NextRequest, NextResponse } from 'next/server';
import { suggestRoleForStage } from '@/lib/anthropic/remap';

export const dynamic = 'force-dynamic';

/** POST {stageId} — Claude's suggested semantic role. Suggestion only; never applied here. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.stageId !== 'string' || !body.stageId) {
      return NextResponse.json({ error: 'stageId is required' }, { status: 400 });
    }
    const result = await suggestRoleForStage(body.stageId);
    return NextResponse.json(result, { status: result.ok || result.notConfigured ? 200 : result.error === 'Stage not found' ? 404 : 500 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to suggest a role', detail: String(error) }, { status: 500 });
  }
}
