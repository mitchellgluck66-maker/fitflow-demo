import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { resumeTurn } from '@/lib/analyst/service';
import { analystStore } from '@/lib/analyst/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST { confirmedUsd? } — resume after a `continue` event (time budget) or a cost confirmation. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { confirmedUsd?: unknown };
    const confirmedUsd = typeof body.confirmedUsd === 'number' && Number.isFinite(body.confirmedUsd) ? body.confirmedUsd : null;
    const turn = await analystStore().getTurn(id);
    if (!turn) return NextResponse.json({ error: `No turn "${id}"` }, { status: 404 });
    if (turn.status === 'needs_confirmation' && confirmedUsd === null) return NextResponse.json({ ok: false, error: 'This turn is waiting for a cost confirmation: send confirmedUsd' }, { status: 400 });
    if (turn.status !== 'running' && turn.status !== 'needs_confirmation') return NextResponse.json({ ok: false, error: `Turn is ${turn.status}` }, { status: 409 });
    after(() => resumeTurn(id, { confirmedUsd }).catch(() => undefined));
    return NextResponse.json({ ok: true, turnId: id, resumed: true });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to resume the turn');
  }
}
