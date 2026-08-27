/**
 * Nightly insight cards. Cached in ai_reports by the sha256 of the metrics
 * snapshot: same numbers → same report, no API call.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, aiReports } from '@/db';
import { getScorecard } from '../metrics/service';
import { buildInsightInput, hashInsightInput, validateInsights, InsightsAnswerSchema, type InsightFinding, type InsightInput } from '../metrics/insights';
import { askClaude } from './client';
import { getAnthropicConfig } from './config';
import { INSIGHTS_SYSTEM, INSIGHTS_TOOL_SCHEMA } from './prompts';

export interface InsightsContent {
  findings: InsightFinding[];
  generatedAt: string;
  model: string;
  input: InsightInput;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

export interface InsightsResult {
  ok: boolean;
  notConfigured?: boolean;
  cached: boolean;
  reportId: string | null;
  findings: InsightFinding[];
  generatedAt: string | null;
  model: string | null;
  periodStart: string;
  periodEnd: string;
  inputHash: string;
  error?: string;
}

async function findCached(inputHash: string) {
  const [row] = await db
    .select()
    .from(aiReports)
    .where(and(eq(aiReports.kind, 'insight'), eq(aiReports.inputHash, inputHash)))
    .orderBy(desc(aiReports.createdAt))
    .limit(1);
  return row ?? null;
}

export async function runInsights(params: { range?: string | null; compare?: string | null; start?: string | null; end?: string | null; force?: boolean } = {}): Promise<InsightsResult> {
  const result = await getScorecard({ range: params.range ?? 'this_week', compare: params.compare ?? 'previous_period', start: params.start, end: params.end });
  const input = buildInsightInput(result);
  const inputHash = hashInsightInput(input);
  const base = { periodStart: result.range.start, periodEnd: result.range.end, inputHash };

  if (!params.force) {
    const cached = await findCached(inputHash);
    if (cached) {
      const c = cached.content as unknown as InsightsContent;
      return { ok: true, cached: true, reportId: cached.id, findings: c.findings, generatedAt: c.generatedAt, model: cached.model, ...base };
    }
  }

  const config = await getAnthropicConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, cached: false, reportId: null, findings: [], generatedAt: null, model: null, ...base, error: 'Anthropic not configured' };
  }

  const answer = await askClaude({
    system: INSIGHTS_SYSTEM,
    user: `Metrics snapshot (JSON):\n${JSON.stringify(input)}`,
    inputSchema: INSIGHTS_TOOL_SCHEMA as unknown as Record<string, unknown>,
    schema: InsightsAnswerSchema,
    toolName: 'submit_findings',
    maxTokens: 1500,
  });
  if (!answer.ok || !answer.data) {
    return { ok: false, notConfigured: answer.notConfigured, cached: false, reportId: null, findings: [], generatedAt: null, model: answer.model, ...base, error: answer.error };
  }
  const validated = validateInsights(answer.data, input.deepLinks);
  if (!validated.ok) {
    return { ok: false, cached: false, reportId: null, findings: [], generatedAt: null, model: answer.model, ...base, error: validated.error };
  }

  const content: InsightsContent = { findings: validated.findings, generatedAt: new Date().toISOString(), model: answer.model ?? config.model, input, usage: answer.usage };
  const [row] = await db
    .insert(aiReports)
    .values({ kind: 'insight', periodStart: base.periodStart, periodEnd: base.periodEnd, model: content.model, inputHash, content: content as unknown as Record<string, unknown> })
    .returning({ id: aiReports.id });
  return { ok: true, cached: false, reportId: row.id, findings: content.findings, generatedAt: content.generatedAt, model: content.model, ...base };
}

/** Latest stored insights for a period (no generation). */
export async function getLatestInsights(range: { start: string; end: string }): Promise<{ findings: InsightFinding[]; generatedAt: string | null; model: string | null; reportId: string | null }> {
  const [row] = await db
    .select()
    .from(aiReports)
    .where(and(eq(aiReports.kind, 'insight'), eq(aiReports.periodStart, range.start), eq(aiReports.periodEnd, range.end)))
    .orderBy(desc(aiReports.createdAt))
    .limit(1);
  if (!row) return { findings: [], generatedAt: null, model: null, reportId: null };
  const c = row.content as unknown as InsightsContent;
  return { findings: c.findings, generatedAt: c.generatedAt, model: row.model, reportId: row.id };
}
