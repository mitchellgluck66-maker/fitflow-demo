import { NextRequest, NextResponse } from 'next/server';
import { listClients, type ClientListParams } from '@/lib/queries/clients';

export const dynamic = 'force-dynamic';

const SORTS = new Set(['applied', 'name', 'stage', 'source', 'activity', 'applied_desc', 'applied_asc', 'name_asc', 'activity_desc']);

/**
 * GET /api/clients?q&stage=a,b&source=x,y&status=open,won&appt=Consult&from&to&sort&dir&limit&offset
 * Multi-value filters are comma lists (OR within, AND across). Read-only.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const sort = p.get('sort');
    const dir = p.get('dir');
    const result = await listClients({
      q: p.get('q'),
      stageId: p.get('stage'),
      source: p.get('source'),
      status: p.get('status'),
      apptType: p.get('appt'),
      from: p.get('from'),
      to: p.get('to'),
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
      offset: p.get('offset') ? Number(p.get('offset')) : undefined,
      sort: sort && SORTS.has(sort) ? (sort as ClientListParams['sort']) : undefined,
      dir: dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to list clients', detail: String(error) }, { status: 500 });
  }
}
