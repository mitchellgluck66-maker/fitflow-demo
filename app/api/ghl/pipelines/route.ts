import { NextRequest, NextResponse } from 'next/server';
import { db, stages, pipelines, syncIncidents } from '@/db';
import { eq, isNull, and, desc } from 'drizzle-orm';
import { listStages } from '@/lib/queries/contacts';
import { isSemanticRole, ROLE_LABELS, SEMANTIC_ROLES } from '@/lib/ghl/roles';
import { isOffPipeline, isDefaultFollowedPipeline } from '@/lib/ghl/followed';
import { resolveStageIncidents } from '@/lib/ghl/ingest';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ghl/pipelines — the dynamic stage model as currently mirrored:
 * pipelines, their stages with semantic roles, unmapped stages and open
 * incidents. Powers the stage-role mapping panel in Setup.
 */
export async function GET() {
  try {
    const [pipelineRows, stageRows, incidents] = await Promise.all([
      db.select().from(pipelines).orderBy(pipelines.position),
      listStages(),
      db
        .select()
        .from(syncIncidents)
        .where(isNull(syncIncidents.resolvedAt))
        .orderBy(desc(syncIncidents.createdAt))
        .limit(50),
    ]);

    // "{ Off }..." pipelines are retired: sorted to the bottom, never
    // suggested for following. Only followed pipelines surface unmapped-stage
    // warnings — the rest are collapsed noise.
    const sorted = [...pipelineRows].sort((a, b) => {
      const off = Number(isOffPipeline(a.name)) - Number(isOffPipeline(b.name));
      return off !== 0 ? off : (a.position ?? 0) - (b.position ?? 0);
    });
    const followedIds = new Set(pipelineRows.filter((p) => p.isTracked && p.archivedAt === null).map((p) => p.id));

    return NextResponse.json({
      pipelines: sorted.map((p) => ({
        id: p.id,
        name: p.name,
        isTracked: p.isTracked,
        isDefault: isDefaultFollowedPipeline(p.id),
        isOff: isOffPipeline(p.name),
        archived: p.archivedAt !== null,
        origin: p.origin,
        syncedAt: p.syncedAt.toISOString(),
        stages: stageRows.filter((s) => s.pipelineId === p.id),
      })),
      unmapped: stageRows.filter((s) => !s.archived && s.semanticRole === null && followedIds.has(s.pipelineId)),
      roles: SEMANTIC_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
      incidents: incidents.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), resolvedAt: null })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read pipelines', detail: String(error) }, { status: 500 });
  }
}

/**
 * PATCH /api/ghl/pipelines
 * Body: { stageId, semanticRole }   — manual role override (never touched by sync)
 *       { pipelineId, isTracked }   — include/exclude a pipeline from the funnel
 * Local-only: nothing here is written to GoHighLevel.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body.stageId === 'string') {
      if (!isSemanticRole(body.semanticRole)) {
        return NextResponse.json({ error: `semanticRole must be one of ${SEMANTIC_ROLES.join(', ')}` }, { status: 400 });
      }
      const [updated] = await db
        .update(stages)
        .set({ semanticRole: body.semanticRole, roleSource: 'manual', updatedAt: new Date() })
        .where(eq(stages.id, body.stageId))
        .returning({ id: stages.id });
      if (!updated) return NextResponse.json({ error: 'Stage not found' }, { status: 404 });
      await resolveStageIncidents(body.stageId);
      return NextResponse.json({ ok: true, stageId: body.stageId, semanticRole: body.semanticRole });
    }

    if (typeof body.pipelineId === 'string' && typeof body.isTracked === 'boolean') {
      const [updated] = await db
        .update(pipelines)
        .set({ isTracked: body.isTracked, updatedAt: new Date() })
        .where(and(eq(pipelines.id, body.pipelineId)))
        .returning({ id: pipelines.id });
      if (!updated) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
      return NextResponse.json({ ok: true, pipelineId: body.pipelineId, isTracked: body.isTracked });
    }

    return NextResponse.json({ error: 'Provide { stageId, semanticRole } or { pipelineId, isTracked }' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update mapping', detail: String(error) }, { status: 500 });
  }
}
