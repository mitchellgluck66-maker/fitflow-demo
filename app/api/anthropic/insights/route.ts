import { NextRequest, NextResponse } from 'next/server';
import { getLatestInsights, runInsights } from '@/lib/anthropic/insights';
import { getAnthropicConfig } from '@/lib/anthropic/config';
import { and, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { ANTHROPIC_INCIDENT_KIND } from '@/lib/anthropic/incident';
import { getTimezone } from '@/lib/settings';
import { rangeFromParams, todayInTimezone } from '@/lib/dates';
import { insightsEnabled, INSIGHTS_PAUSED_REASON, INSIGHTS_PAUSED_TEXT } from '@/lib/anthropic/insightsFlag';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET ?range&start&end — latest cached findings for that period (no generation). */
export async function GET(request: NextRequest) {
  try {
    // 2026-10-15: paused (default) — the card shows one line and nothing stored is served.
    if (!insightsEnabled()) return NextResponse.json({ paused: true, message: INSIGHTS_PAUSED_TEXT, notConfigured: false, cached: true, findings: [], generatedAt: null, model: null, lastError: null });
    const p = request.nextUrl.searchParams;
    const config = await getAnthropicConfig();
    const timezone = await getTimezone();
    const range = rangeFromParams({ range: p.get('range'), start: p.get('start'), end: p.get('end') }, todayInTimezone(timezone));
    const latest = await getLatestInsights(range);
    // Stored findings (including pre-generated demo reports) render without a
    // key; "not configured" only when there is nothing to show.
    const notConfigured = !config.configured && latest.findings.length === 0;
    // Never an empty card: when an AI call is failing, the card says why (the one open anthropic_error incident).
    const [failing] = await db.select({ message: syncIncidents.message }).from(syncIncidents)
      .where(and(eq(syncIncidents.kind, ANTHROPIC_INCIDENT_KIND), isNull(syncIncidents.resolvedAt))).limit(1);
    return NextResponse.json({ notConfigured, cached: true, range: { start: range.start, end: range.end }, ...latest, lastError: failing?.message ?? null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read insights', detail: String(error) }, { status: 500 });
  }
}

/** POST {range?, compare?, start?, end?, force?} — generate now. */
export async function POST(request: NextRequest) {
  try {
    if (!insightsEnabled()) return NextResponse.json({ ok: false, paused: true, reason: INSIGHTS_PAUSED_REASON, error: INSIGHTS_PAUSED_TEXT }, { status: 409 });
    const body = await request.json().catch(() => ({}));
    const result = await runInsights({ range: body.range, compare: body.compare, start: body.start, end: body.end, force: body.force === true });
    return NextResponse.json(result, { status: result.ok || result.notConfigured ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to generate insights', detail: String(error) }, { status: 500 });
  }
}
