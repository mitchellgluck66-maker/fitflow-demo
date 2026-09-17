import { NextRequest, NextResponse } from 'next/server';
import { getClientProfile } from '@/lib/queries/clients';
import { setAttributionOverride } from '@/lib/attribution/run';
import { isAttributionClass } from '@/lib/attribution/classify';

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

/**
 * PATCH /api/clients/[id] { attributionClass: 'paid' | 'organic' | null, note? }
 * Manual paid/organic override (null restores the automatic class). This is a
 * FitFlow-local label — nothing is written to GoHighLevel.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (!('attributionClass' in body) || (body.attributionClass !== null && !isAttributionClass(body.attributionClass))) {
      return NextResponse.json({ error: "attributionClass must be 'paid', 'organic' or null" }, { status: 400 });
    }
    const result = await setAttributionOverride(id, body.attributionClass, typeof body.note === 'string' ? body.note : undefined);
    if (!result.ok) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update attribution', detail: String(error) }, { status: 500 });
  }
}
