import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { previewPayload, PREVIEW_STATES, type PreviewState } from '@/lib/analyst/preview';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analyst/preview?state=answer — a panel state for the screenshot harness (Wave 2 item 8), built from the
 * demo-tenant replay fixture through the panel's own view shape. Exists ONLY when the server runs with
 * ANALYST_PREVIEW=1 outside production (404 otherwise): never a production surface, never customer data (the fixture
 * is recorded on the demo tenant by construction).
 */
export async function GET(request: NextRequest) {
  if (process.env.ANALYST_PREVIEW !== '1' || process.env.NODE_ENV === 'production' || process.env.VERCEL) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const state = request.nextUrl.searchParams.get('state') ?? 'welcome';
  if (!(PREVIEW_STATES as readonly string[]).includes(state)) return NextResponse.json({ error: `unknown state "${state}" — one of ${PREVIEW_STATES.join(', ')}` }, { status: 400 });
  const file = path.join(process.cwd(), 'tests', 'fixtures', 'analyst-replay', 'turn-1.json');
  const fixture = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Parameters<typeof previewPayload>[1]) : null;
  return NextResponse.json(previewPayload(state as PreviewState, fixture), { headers: { 'Cache-Control': 'no-store' } });
}
