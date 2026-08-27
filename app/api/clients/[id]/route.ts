import { NextRequest, NextResponse } from 'next/server';
import { getClientProfile } from '@/lib/queries/clients';

export const dynamic = 'force-dynamic';

/** GET /api/clients/[id] — profile + unified timeline (read-only). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const profile = await getClientProfile(id);
    if (!profile) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    return NextResponse.json(profile);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load client', detail: String(error) }, { status: 500 });
  }
}
