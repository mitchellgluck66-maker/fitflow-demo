/**
 * Weekly / monthly narrative paragraph for the scorecard emails. Generated
 * by the nightly job and cached in ai_reports; the email builder only READS.
 */

import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, aiReports } from '@/db';
import { getScorecard } from '../metrics/service';
import { buildInsightInput, hashInsightInput } from '../metrics/insights';
import { askClaude } from './client';
import { getAnthropicConfig } from './config';
import { NARRATIVE_SYSTEM, NARRATIVE_TOOL_SCHEMA } from './prompts';

export type NarrativeKind = 'weekly' | 'monthly';
const REPORT_KIND: Record<NarrativeKind, string> = { weekly: 'weekly_narrative', monthly: 'monthly_narrative' };
const NarrativeSchema = z.object({ paragraph: z.string().min(1).max(1200) });

export interface NarrativeResult {
  ok: boolean;
  notConfigured?: boolean;
  cached: boolean;
  paragraph: string | null;
  periodStart: string;
  periodEnd: string;
  model: string | null;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** True when dryRun: the paragraph was generated and validated but NOT stored. */
  dryRun?: boolean;
}

/**
 * `dryRun` (the smoke test, 2026-09-30): generate + validate, never store. Monday's digest reuses whatever
 * paragraph is stored for the period, so a smoke run must not leave one behind.
 */
export async function runWeeklyNarrative(kind: NarrativeKind, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<NarrativeResult> {
  const result = await getScorecard({ range: kind === 'weekly' ? 'last_week' : 'last_month', compare: 'previous_period' });
  const input = buildInsightInput(result);
  const inputHash = hashInsightInput(input);
  const base = { periodStart: result.range.start, periodEnd: result.range.end };

  // One narrative per period (2026-09-29 heartbeat): the dispatch now runs hourly and last week's numbers
  // still move on Monday, so a hash cache would regenerate on every run. force (manual) always regenerates.
  if (!opts.force) {
    const [cached] = await db
      .select()
      .from(aiReports)
      .where(and(eq(aiReports.kind, REPORT_KIND[kind]), eq(aiReports.periodStart, base.periodStart), eq(aiReports.periodEnd, base.periodEnd)))
      .orderBy(desc(aiReports.createdAt))
      .limit(1);
    if (cached) return { ok: true, cached: true, paragraph: String((cached.content as { paragraph?: string }).paragraph ?? ''), model: cached.model, ...base };
  }

  const config = await getAnthropicConfig();
  if (!config.configured) return { ok: false, notConfigured: true, cached: false, paragraph: null, model: null, ...base, error: 'Anthropic not configured' };
  if (result.scorecard.empty) return { ok: true, cached: false, paragraph: null, model: null, ...base, error: 'empty period' };

  const answer = await askClaude({
    system: NARRATIVE_SYSTEM,
    user: `Period kind: ${kind}. Metrics snapshot (JSON):\n${JSON.stringify(input)}`,
    inputSchema: NARRATIVE_TOOL_SCHEMA as unknown as Record<string, unknown>,
    schema: NarrativeSchema,
    toolName: 'submit_paragraph',
    maxTokens: 600,
  });
  if (!answer.ok || !answer.data) {
    return { ok: false, notConfigured: answer.notConfigured, cached: false, paragraph: null, model: answer.model, ...base, error: answer.error };
  }
  const paragraph = answer.data.paragraph.trim();
  if (opts.dryRun) return { ok: true, cached: false, paragraph, model: answer.model, usage: answer.usage, dryRun: true, ...base };
  await db.insert(aiReports).values({
    kind: REPORT_KIND[kind],
    periodStart: base.periodStart,
    periodEnd: base.periodEnd,
    model: answer.model ?? config.model,
    inputHash,
    content: { paragraph, generatedAt: new Date().toISOString(), input, usage: answer.usage },
  });
  return { ok: true, cached: false, paragraph, model: answer.model, usage: answer.usage, ...base };
}

/** Read-only lookup used by the email builder. */
export async function getNarrative(kind: NarrativeKind, periodStart: string, periodEnd: string): Promise<string | null> {
  const [row] = await db
    .select({ content: aiReports.content })
    .from(aiReports)
    .where(and(eq(aiReports.kind, REPORT_KIND[kind]), eq(aiReports.periodStart, periodStart), eq(aiReports.periodEnd, periodEnd)))
    .orderBy(desc(aiReports.createdAt))
    .limit(1);
  const p = row ? (row.content as { paragraph?: string }).paragraph : null;
  return p && p.trim() ? p.trim() : null;
}
