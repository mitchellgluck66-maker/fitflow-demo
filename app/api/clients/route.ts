import { NextRequest, NextResponse } from 'next/server';
import { listClients, type ClientListParams } from '@/lib/queries/clients';

export const dynamic = 'force-dynamic';

/** GET /api/clients?q&stage&source&from&to&limit&offset&sort — read-only index. */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const sort = p.get('sort');
    const result = await listClients({
      q: p.get('q'),
      stageId: p.get('stage'),
      source: p.get('source'),
      from: p.get('from'),
      to: p.get('to'),
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
      offset: p.get('offset') ? Number(p.get('offset')) : undefined,
      sort: (['applied_desc', 'applied_asc', 'name_asc', 'activity_desc'] as const).includes(sort as ClientListParams['sort'] & string)
        ? (sort as ClientListParams['sort'])
        : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to list clients', detail: String(error) }, { status: 500 });
  }
}
