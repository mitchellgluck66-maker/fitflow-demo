import { NextRequest, NextResponse } from 'next/server';
import { importFromGhl, getDataProvenance } from '@/lib/ghl/import';
import { todayInTimezone, addDays } from '@/lib/day';
import { getTimezone, getSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';

export const dynamic = 'force-dynamic';
// An import of several hundred appointments walks a lot of rate-limited calls.
export const maxDuration = 300;

/** GET /api/ghl/import — what's currently in the database, and where it came from. */
export async function GET() {
  try {
    return NextResponse.json(await getDataProvenance());
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read provenance', detail: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/ghl/import
 * Body: { calendarIds[], pipelineId?, startDate?, endDate?, clearDemoData? }
 *
 * Defaults to the last 60 days through the next 30 - enough history for the
 * metrics to mean something, plus the upcoming schedule for the Today View.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const timezone = await getTimezone();
    const today = todayInTimezone(timezone);

    // Fall back to the calendars saved in Setup when none are passed.
    let calendarIds: string[] = Array.isArray(body.calendarIds) ? body.calendarIds : [];
    if (calendarIds.length === 0) {
      const raw = await getSetting(CREDENTIAL_KEYS.followedCalendars);
      try {
        calendarIds = raw ? JSON.parse(raw) : [];
      } catch {
        calendarIds = [];
      }
    }

    if (calendarIds.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one calendar to import from.' },
        { status: 400 },
      );
    }

    const result = await importFromGhl({
      calendarIds,
      pipelineId: body.pipelineId,
      startDate: body.startDate ?? addDays(today, -60),
      endDate: body.endDate ?? addDays(today, 30),
      clearDemoData: body.clearDemoData ?? false,
    });

    const c = result.counts;

    return NextResponse.json({
      ...result,
      provenance: await getDataProvenance(),
      message: result.ok
        ? `Imported ${c.appointmentsCreated} new appointments and ${c.leadsCreated} new leads from GoHighLevel` +
          (c.demoRowsRemoved > 0 ? `, and removed ${c.demoRowsRemoved} sample leads.` : '.')
        : (result.error ?? 'Import failed'),
    });
  } catch (error) {
    console.error('Import failed:', error);
    return NextResponse.json(
      { ok: false, error: 'Import failed', detail: String(error) },
      { status: 500 },
    );
  }
}
