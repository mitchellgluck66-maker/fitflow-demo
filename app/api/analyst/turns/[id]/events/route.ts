import { NextRequest } from 'next/server';
import { analystStore } from '@/lib/analyst/store';
import { sweepAndRecord } from '@/lib/analyst/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TERMINAL = new Set(['done', 'failed', 'stopped', 'needs_confirmation']);

/**
 * GET /api/analyst/turns/[id]/events?after=N — the turn's progress events as SSE, replayed from N
 * (reconnect-safe), then polled until the turn reaches a terminal state or a `continue` event.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = analystStore();
  await sweepAndRecord(store);
  let after = Math.max(0, Number(request.nextUrl.searchParams.get('after') ?? 0) || 0);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>, index: number) => controller.enqueue(encoder.encode(`id: ${index}\nevent: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
      const startedAt = Date.now();
      try {
        while (Date.now() - startedAt < 280_000) {
          const turn = await store.getTurn(id);
          if (!turn) {
            send({ type: 'error', message: `No turn "${id}"`, retryable: false }, after);
            break;
          }
          const fresh = turn.events.slice(after);
          for (const e of fresh) {
            after += 1;
            send(e, after);
          }
          const last = turn.events[turn.events.length - 1] as { type?: string } | undefined;
          if (TERMINAL.has(turn.status) || last?.type === 'continue' || last?.type === 'done') break;
          if (request.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 700));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
