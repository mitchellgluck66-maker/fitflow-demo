import { NextResponse } from 'next/server';
import { clearDemoData, getDataProvenance } from '@/lib/ghl/import';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ghl/reset — delete every fabricated sample row.
 *
 * Only touches rows whose origin is 'demo'. Imported and manually-entered data
 * is never affected, so this is safe to run after a real import.
 */
export async function POST() {
  try {
    const removed = await clearDemoData();

    return NextResponse.json({
      ok: true,
      ...removed,
      provenance: await getDataProvenance(),
      message:
        removed.leadsRemoved === 0 && removed.appointmentsRemoved === 0
          ? 'No sample data found — the database is already clean.'
          : `Removed ${removed.leadsRemoved} sample leads, ${removed.appointmentsRemoved} appointments and ${removed.eventsRemoved} audit events.`,
    });
  } catch (error) {
    console.error('Reset failed:', error);
    return NextResponse.json(
      { error: 'Reset failed', detail: String(error) },
      { status: 500 },
    );
  }
}
