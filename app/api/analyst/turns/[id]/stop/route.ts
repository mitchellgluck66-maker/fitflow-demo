import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { analystStore } from '@/lib/analyst/store';

export const dynamic = 'force-dynamic';

/** POST — an explicit Stop: the loop ends before its next round and stores nothing from the unfinished one. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const store = analystStore();
    const turn = await store.getTurn(id);
    if (!turn) return NextResponse.json({ error: `No turn "${id}"` }, { status: 404 });
    if (turn.status !== 'running' && turn.status !== 'needs_confirmation') return NextResponse.json({ ok: true, status: turn.status, note: 'already finished' });
    await store.updateTurn(id, { stopRequested: true, ...(turn.status === 'needs_confirmation' ? { status: 'stopped', finishedAt: new Date() } : {}) });
    return NextResponse.json({ ok: true, status: turn.status === 'needs_confirmation' ? 'stopped' : 'stopping' });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to stop the turn');
  }
}
