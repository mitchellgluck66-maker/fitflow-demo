import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/settings';
import { DISPLAY_METRICS, DISPLAYED_METRICS_SETTING, parseDisplayedMetrics, serializeDisplayedMetrics, DEFAULT_DISPLAYED_METRICS } from '@/lib/metrics/display';

export const dynamic = 'force-dynamic';

/** GET — the catalog plus the keys currently enabled (defaults until the CEO changes them). */
export async function GET() {
  try {
    const enabled = parseDisplayedMetrics(await getSetting(DISPLAYED_METRICS_SETTING));
    return NextResponse.json({ catalog: DISPLAY_METRICS, enabled, defaults: DEFAULT_DISPLAYED_METRICS });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read displayed metrics', detail: String(error) }, { status: 500 });
  }
}

/** POST { enabled: string[] } — persist. Unknown keys are dropped. `{ reset: true }` restores the defaults. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const next = body.reset === true ? [...DEFAULT_DISPLAYED_METRICS] : parseDisplayedMetrics(JSON.stringify(Array.isArray(body.enabled) ? body.enabled : []));
    await setSetting(DISPLAYED_METRICS_SETTING, serializeDisplayedMetrics(next));
    return NextResponse.json({ ok: true, enabled: next });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save displayed metrics', detail: String(error) }, { status: 500 });
  }
}
