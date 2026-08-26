import { NextResponse } from 'next/server';
import { listContactsAsLeads, listStages } from '@/lib/queries/contacts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/leads — every contact with its current stage (read-only view).
 * Returns the array directly for the existing pages; `?withStages=1` wraps
 * it with the ordered stage list so pages can stop hard-coding stage names.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const leads = await listContactsAsLeads();
    if (url.searchParams.get('withStages')) {
      return NextResponse.json({ leads, stages: await listStages() });
    }
    return NextResponse.json(leads);
  } catch (error) {
    console.error('Failed to fetch leads:', error);
    return NextResponse.json({ error: 'Failed to fetch leads' }, { status: 500 });
  }
}

/** FitFlow is read-only: contacts come from GoHighLevel, never from here. */
export async function POST() {
  return NextResponse.json(
    { error: 'FitFlow is read-only. Create contacts in GoHighLevel; they appear here on the next sync.' },
    { status: 405 },
  );
}
