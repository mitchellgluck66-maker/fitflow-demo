/**
 * F4 (2026-09-30): stage roles are resolved at READ time through `stages.semantic_role`. The Sep 17 remap
 * (Previous Leads, Roadmap No Show, the reschedule stages) never reached the 137 transitions written before it:
 * "Previous leads" read 0 and re-engaged leads counted as applied. A remap must change history immediately,
 * without rewriting stage_transitions; the stored role is only the fallback for a stage that no longer exists.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, stageTransitions } from '@/db';
import { loadMetricsInput } from '@/lib/metrics/load';
import { computeFunnel } from '@/lib/metrics';

const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
const RANGE = { start: '2026-09-01', end: '2026-09-30' };
let lead: string;

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values({ id: 'p1', name: 'Applications', isTracked: true, ...prov });
  await db.insert(stages).values([
    { id: 's-applied', pipelineId: 'p1', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    // As before Sep 17: the stage existed but was mapped "other".
    { id: 's-prev', pipelineId: 'p1', name: 'Previous Leads', position: 1, semanticRole: 'other', roleSource: 'auto', ...prov },
  ]);
  const [c] = await db
    .insert(contacts)
    .values({ ghlContactId: 'c-prev', ghlOpportunityId: 'o-prev', pipelineId: 'p1', stageId: 's-applied', firstName: 'Old', lastName: 'Lead', ghlCreatedAt: new Date('2025-01-10T18:00:00Z'), opportunityCreatedAt: new Date('2026-09-10T18:00:00Z'), ...prov })
    .returning({ id: contacts.id });
  lead = c.id;
  // History written before the remap: parked in Previous Leads (stored role "other"), re-engaged into Applied.
  await db.insert(stageTransitions).values([
    { contactId: lead, pipelineId: 'p1', toStageId: 's-prev', toRole: 'other', observedAt: new Date('2026-09-02T18:00:00Z'), kind: 'backfill', ...prov },
    { contactId: lead, pipelineId: 'p1', fromStageId: 's-prev', fromRole: 'other', toStageId: 's-applied', toRole: 'applied', observedAt: new Date('2026-09-12T18:00:00Z'), kind: 'diff', ...prov },
  ]);
});

const load = () => loadMetricsInput({ ...RANGE, timezone: 'America/Edmonton' });

describe('roles resolved at read time', () => {
  it('before the remap the stale history counts the parked lead as an applicant (the production bug)', async () => {
    const input = await load();
    expect(input.transitions.find((t) => t.toStageId === 's-prev')?.toRole).toBe('other');
    const funnel = computeFunnel(input, RANGE);
    expect(funnel.previousLeads.count).toBe(0);
    expect(funnel.stages.find((s) => s.key === 'applied')?.count).toBe(1);
  });

  it('a Setup remap reaches history at once — no rewrite of stage_transitions; the lead is parked, not an applicant', async () => {
    await db.update(stages).set({ semanticRole: 'previous_lead', roleSource: 'manual' }).where(eq(stages.id, 's-prev'));
    const input = await load();
    expect(input.transitions.find((t) => t.toStageId === 's-prev')?.toRole).toBe('previous_lead');
    expect(input.transitions.find((t) => t.toStageId === 's-applied')?.fromRole).toBe('previous_lead');
    const funnel = computeFunnel(input, RANGE);
    expect(funnel.previousLeads.count).toBe(1);
    expect(funnel.stages.find((s) => s.key === 'applied')?.count).toBe(0);
    // The table itself still records the role at observation.
    const stored = await db.select().from(stageTransitions).where(eq(stageTransitions.toStageId, 's-prev'));
    expect(stored[0].toRole).toBe('other');
  });

  it('a stage that no longer exists falls back to the stored role', async () => {
    await db.insert(stageTransitions).values({ contactId: lead, pipelineId: 'p1', toStageId: 's-deleted', toRole: 'consult_booked', observedAt: new Date('2026-09-20T18:00:00Z'), kind: 'diff', ...prov });
    const input = await load();
    expect(input.transitions.find((t) => t.toStageId === 's-deleted')?.toRole).toBe('consult_booked');
  });
});
