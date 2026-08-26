import { NextRequest, NextResponse } from 'next/server';
import { discoverAccount, saveMapping, buildStageMapping } from '@/lib/ghl/discover';
import { listPipelines } from '@/lib/ghl/client';
import { getDataProvenance } from '@/lib/ghl/import';

export const dynamic = 'force-dynamic';

/** GET /api/ghl/discover — read the account's calendars, pipelines and users. */
export async function GET() {
  try {
    const [discovery, provenance] = await Promise.all([
      discoverAccount(),
      getDataProvenance(),
    ]);

    return NextResponse.json({ ...discovery, provenance });
  } catch (error) {
    console.error('Discovery failed:', error);
    return NextResponse.json(
      { ok: false, error: 'Discovery failed', detail: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/ghl/discover — save the confirmed pipeline/stage/calendar mapping.
 * Body: { pipelineId, stageMap, calendarMap }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.pipelineId) {
      return NextResponse.json({ error: 'pipelineId is required' }, { status: 400 });
    }

    // If no explicit stage map was supplied, derive one from the pipeline.
    let stageMap: Record<string, string> = body.stageMap ?? {};

    if (Object.keys(stageMap).length === 0) {
      const pipelines = await listPipelines();
      const pipeline = pipelines.data?.pipelines?.find((p) => p.id === body.pipelineId);

      if (pipeline) {
        for (const mapping of buildStageMapping(pipeline)) {
          if (mapping.ghlStageId) stageMap[mapping.localStage] = mapping.ghlStageId;
        }
      }
    }

    await saveMapping({
      pipelineId: body.pipelineId,
      stageMap,
      calendarMap: body.calendarMap ?? {},
    });

    return NextResponse.json({
      ok: true,
      pipelineId: body.pipelineId,
      mappedStages: Object.keys(stageMap).length,
      stageMap,
    });
  } catch (error) {
    console.error('Failed to save mapping:', error);
    return NextResponse.json(
      { error: 'Failed to save mapping', detail: String(error) },
      { status: 500 },
    );
  }
}
