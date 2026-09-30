import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { executeTurn, prepareTurn, type TurnRequest } from '@/lib/analyst/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/analyst/turns — start a turn. Returns at once with the turn id; the run continues under
 * after() so it outlives the connection (rule 5). Progress is on GET /api/analyst/turns/[id]/events.
 * Idempotent on clientTurnId. 402-style needs_confirmation carries the estimate; nothing is spent.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<TurnRequest>;
    if (typeof body.clientTurnId !== 'string' || !body.clientTurnId) return NextResponse.json({ error: 'clientTurnId is required' }, { status: 400 });
    if (typeof body.question !== 'string' && body.kind !== 'explain' && body.kind !== 'report') return NextResponse.json({ error: 'question is required' }, { status: 400 });
    const kind = body.kind === 'explain' || body.kind === 'report' ? body.kind : 'ask';
    const prepared = await prepareTurn({ threadId: body.threadId ?? null, clientTurnId: body.clientTurnId, question: body.question ?? '', kind, context: body.context ?? null, explainKey: body.explainKey ?? null, preset: body.preset ?? null, depth: body.depth ?? 'default', confirmedUsd: body.confirmedUsd ?? null });
    if (!prepared.ok) {
      if (prepared.status === 'needs_confirmation') return NextResponse.json({ ok: false, status: 'needs_confirmation', threadId: prepared.thread.id, estimate: prepared.estimate, reason: prepared.reason, spentMonthUsd: prepared.spentMonthUsd }, { status: 200 });
      const status = prepared.status === 'busy' ? 409 : prepared.status === 'not_configured' || prepared.status === 'no_brief' ? 412 : 400;
      return NextResponse.json({ ok: false, status: prepared.status, error: prepared.message, threadId: prepared.thread?.id ?? null }, { status });
    }
    if (prepared.created) after(() => executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps).catch(() => undefined));
    return NextResponse.json({ ok: true, threadId: prepared.thread.id, turnId: prepared.turn.id, created: prepared.created, estimate: prepared.estimate, allowedUsd: prepared.allowedUsd, model: prepared.thread.model });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to start the Analyst turn');
  }
}
