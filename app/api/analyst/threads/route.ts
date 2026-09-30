import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { analystStore } from '@/lib/analyst/store';
import { sweepAndRecord } from '@/lib/analyst/service';

export const dynamic = 'force-dynamic';

/** GET — the shared thread list (one history; no author filter). */
export async function GET() {
  try {
    const store = analystStore();
    await sweepAndRecord(store);
    const threads = await store.listThreads(50);
    return NextResponse.json({ threads: threads.map((t) => ({ id: t.id, title: t.title, model: t.model, createdAt: t.createdAt.toISOString(), lastTurnAt: t.lastTurnAt?.toISOString() ?? null })) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to list threads');
  }
}
