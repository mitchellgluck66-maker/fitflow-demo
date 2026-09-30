import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { readSyncStatus, STALE_AFTER_HOURS, type SourceFreshness } from '@/lib/sync/sourceFreshness';

export const dynamic = 'force-dynamic';

export { STALE_AFTER_HOURS };
export type { SourceFreshness };

/**
 * GET /api/sync/status — the stale-data banner (no external request), called on every page view.
 * The computation lives in lib/sync/sourceFreshness.ts so the Analyst reads the same freshness.
 */
export async function GET() {
  try {
    const status = await readSyncStatus();
    const ghlRow = status.sources.find((s) => s.key === 'ghl')!;
    return NextResponse.json({
      // Back-compat fields (GHL) for anything still reading the old shape.
      configured: ghlRow.configured,
      lastSuccessAt: ghlRow.lastSuccessAt,
      lastRunStatus: ghlRow.lastRunStatus,
      ageHours: ghlRow.ageHours,
      ...status,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read sync status');
  }
}
