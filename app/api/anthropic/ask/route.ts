import { NextRequest, NextResponse } from 'next/server';
import { askDashboard, listAskHistory } from '@/lib/anthropic/ask';
import { getAnthropicConfig } from '@/lib/anthropic/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET ?limit — recent Q&A (newest first) + whether a key exists. */
export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? 20);
    const [config, history] = await Promise.all([getAnthropicConfig(), listAskHistory(Number.isFinite(limit) ? limit : 20)]);
    return NextResponse.json({ configured: config.configured, model: config.model, history });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read questions', detail: String(error) }, { status: 500 });
  }
}

/** POST { question, range?, compare?, start?, end? } — ask now. 429 when rate-limited (5/min). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }
    const result = await askDashboard({ question: body.question, range: body.range, compare: body.compare, start: body.start, end: body.end });
    const status = result.ok ? 200 : result.rateLimited ? 429 : result.notConfigured ? 200 : 502;
    const res = NextResponse.json(result, { status });
    if (result.rateLimited && result.retryAfterSec) res.headers.set('Retry-After', String(result.retryAfterSec));
    return res;
  } catch (error) {
    return NextResponse.json({ error: 'Failed to answer', detail: String(error) }, { status: 500 });
  }
}
