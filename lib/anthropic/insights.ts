/**
 * Nightly insight cards. Cached in ai_reports by the sha256 of the metrics
 * snapshot: same numbers → same report, no API call.
 *
 * 2026-09-29 heartbeat: the dispatch runs hourly and the numbers move
 * between runs, so the hash alone would call the model ~24×/day. The dispatch
 * passes `minIntervalMs` (INSIGHT_MIN_INTERVAL_MS): a card for the same period
 * younger than that is served as-is. Manual / API calls pass nothing.
 */

import { and, desc, eq } from 'drizzle-orm';

/** The dispatch regenerates a period's insight at most this often (keeps the old once-a-day cadence). */
export const INSIGHT_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
import { db, aiReports } from '@/db';
import { getScorecard } from '../metrics/service';
import { buildInsightInput, hashInsightInput, validateInsights, InsightsAnswerSchema, type InsightFinding, type InsightInput } from '../metrics/insights';
import { askClaude } from './client';
import { getAnthropicConfig } from './config';
import { INSIGHTS_SYSTEM, insightsToolSchema } from './prompts';

export interface InsightsContent {
  findings: InsightFinding[];
  generatedAt: string;
  model: string;
  input: InsightInput;
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Links that were not offered and fell back to the Command Center (the finding is kept). */
  warnings?: string[];
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
  /** Why no generation was attempted (fresh card within minIntervalMs). */
  skipped?: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Links that were not offered and fell back to the Command Center (the finding is kept). */
  warnings?: string[];
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

export async function runInsights(params: { range?: string | null; compare?: string | null; start?: string | null; end?: string | null; force?: boolean; minIntervalMs?: number; now?: Date } = {}): Promise<InsightsResult> {
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
    if (params.minIntervalMs) {
      const [recent] = await db
        .select()
        .from(aiReports)
        .where(and(eq(aiReports.kind, 'insight'), eq(aiReports.periodStart, base.periodStart), eq(aiReports.periodEnd, base.periodEnd)))
        .orderBy(desc(aiReports.createdAt))
        .limit(1);
      const now = params.now ?? new Date();
      if (recent && now.getTime() - recent.createdAt.getTime() < params.minIntervalMs) {
        const c = recent.content as unknown as InsightsContent;
        const hours = Math.round(params.minIntervalMs / 3_600_000);
        return { ok: true, cached: true, reportId: recent.id, findings: c.findings, generatedAt: c.generatedAt, model: recent.model, ...base, skipped: `insight for this period generated ${recent.createdAt.toISOString()} — regenerates at most every ${hours}h` };
      }
    }
  }

  const config = await getAnthropicConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, cached: false, reportId: null, findings: [], generatedAt: null, model: null, ...base, error: 'Anthropic not configured' };
  }

  const answer = await askClaude({
    system: INSIGHTS_SYSTEM,
    user: `Metrics snapshot (JSON):\n${JSON.stringify(input)}`,
    // `link` is an enum of THIS snapshot's deepLinks keys (strict mode supports enum) — mapped to URLs below.
    inputSchema: insightsToolSchema(Object.keys(input.deepLinks)) as unknown as Record<string, unknown>,
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

  for (const w of validated.warnings) console.warn(`[insights] ${w}`);
  const content: InsightsContent = { findings: validated.findings, warnings: validated.warnings, generatedAt: new Date().toISOString(), model: answer.model ?? config.model, input, usage: answer.usage };
  const [row] = await db
    .insert(aiReports)
    .values({ kind: 'insight', periodStart: base.periodStart, periodEnd: base.periodEnd, model: content.model, inputHash, content: content as unknown as Record<string, unknown> })
    .returning({ id: aiReports.id });
  return { ok: true, cached: false, reportId: row.id, findings: content.findings, generatedAt: content.generatedAt, model: content.model, usage: answer.usage, warnings: validated.warnings, ...base };
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
