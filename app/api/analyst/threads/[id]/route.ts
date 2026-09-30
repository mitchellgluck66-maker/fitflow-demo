import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { analystStore } from '@/lib/analyst/store';
import { sweepAndRecord } from '@/lib/analyst/service';
import { db, analystTurns } from '@/db';
import { asc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/** GET — a thread's visible transcript: each turn's question, answer (with flags), tool summaries, usage and cost. Never the API log. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const store = analystStore();
    await sweepAndRecord(store);
    const thread = await store.getThread(id);
    if (!thread) return NextResponse.json({ error: `No thread "${id}"` }, { status: 404 });
    const [messages, turns] = await Promise.all([store.listMessages(id), db.select().from(analystTurns).where(eq(analystTurns.threadId, id)).orderBy(asc(analystTurns.startedAt))]);
    return NextResponse.json({
      thread: { id: thread.id, title: thread.title, model: thread.model, effort: thread.effort, answerMode: thread.answerMode, createdAt: thread.createdAt.toISOString(), lastTurnAt: thread.lastTurnAt?.toISOString() ?? null },
      turns: turns.map((t) => ({ id: t.id, status: t.status, question: t.question, kind: t.kind, rounds: t.rounds, costUsd: t.costUsd, usage: t.usage, error: t.error, startedAt: t.startedAt.toISOString(), finishedAt: t.finishedAt?.toISOString() ?? null, events: t.events })),
      transcript: messages.filter((m) => m.display && !('repair' in m.display) && !('rejected' in m.display)).map((m) => ({ seq: m.seq, turnId: m.turnId, role: m.role, display: m.display, at: m.createdAt.toISOString() })),
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the thread');
  }
}
