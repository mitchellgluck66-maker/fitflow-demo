import { NextResponse } from 'next/server';
import { clearDemoData, getDataProvenance } from '@/lib/provenance';

export const dynamic = 'force-dynamic';

/** POST /api/ghl/reset — delete every fabricated sample row (origin='demo'). */
export async function POST() {
  try {
    const removed = await clearDemoData();
    return NextResponse.json({
      ok: true,
      ...removed,
      provenance: await getDataProvenance(),
      message:
        removed.contactsRemoved === 0 && removed.appointmentsRemoved === 0
          ? 'No sample data found — the database is already clean.'
          : `Removed ${removed.contactsRemoved} sample contacts, ${removed.appointmentsRemoved} appointments and ${removed.transitionsRemoved} stage transitions.`,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Reset failed', detail: String(error) }, { status: 500 });
  }
}
