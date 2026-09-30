import { NextRequest, NextResponse } from 'next/server';
import { ANALYST_MODEL_OPTIONS, type AnalystModel } from '@/lib/analyst/config';
import { verifyAnalystConnection } from '@/lib/analyst/verifyConnection';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** POST { model? } — a real two-round streamed tool turn on the model (nothing stored). */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { model?: unknown };
    const model = typeof body.model === 'string' && (ANALYST_MODEL_OPTIONS as readonly string[]).includes(body.model) ? (body.model as AnalystModel) : undefined;
    const result = await verifyAnalystConnection({ model });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, message: `Verification failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  }
}
