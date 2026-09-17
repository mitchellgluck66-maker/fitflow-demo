/**
 * Ask-the-dashboard (Phase G item 8). The CEO types a question; the server
 * assembles the same structured metrics the insight cards use (current +
 * prior period + trailing 8 weeks + campaign table + both funnel modes),
 * hands it to Claude as context, verifies every number in the answer exists
 * in that context, and persists the Q&A in ai_reports (kind 'ask').
 */

import { desc, eq } from 'drizzle-orm';
import { db, aiReports } from '@/db';
import { getScorecard } from '../metrics/service';
import { buildAskContext, hashAskContext, verifyAnswerNumbers, AskAnswerSchema, type AskAnswer, type AskContext } from '../metrics/ask';
import { askClaude } from './client';
import { getAnthropicConfig } from './config';
import { ASK_SYSTEM, ASK_TOOL_SCHEMA } from './prompts';

export const ASK_RATE_LIMIT = 5;
export const ASK_RATE_WINDOW_MS = 60_000;

// Per-instance sliding window (serverless: per warm function). Good enough to
// stop a runaway client; the Anthropic bill is the real backstop.
const hits: number[] = [];

export function checkAskRateLimit(now = Date.now()): { ok: boolean; retryAfterSec: number; remaining: number } {
  while (hits.length && now - hits[0] >= ASK_RATE_WINDOW_MS) hits.shift();
  if (hits.length >= ASK_RATE_LIMIT) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((ASK_RATE_WINDOW_MS - (now - hits[0])) / 1000)), remaining: 0 };
  }
  hits.push(now);
  return { ok: true, retryAfterSec: 0, remaining: ASK_RATE_LIMIT - hits.length };
}

export function resetAskRateLimit(): void {
  hits.length = 0;
}

export interface AskContent {
  question: string;
  answer: string;
  citations: AskAnswer['citations'];
  period: { start: string; end: string; label: string; preset: string };
  comparison: { start: string; end: string; label: string } | null;
  contextHash: string;
  generatedAt: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
}

export interface AskResult {
  ok: boolean;
  notConfigured?: boolean;
  rateLimited?: boolean;
  retryAfterSec?: number;
  reportId: string | null;
  question: string;
  answer: string | null;
  citations: AskAnswer['citations'];
  period: { start: string; end: string; label: string } | null;
  model: string | null;
  generatedAt: string | null;
  error?: string;
}

export async function askDashboard(params: {
  question: string;
  range?: string | null;
  compare?: string | null;
  start?: string | null;
  end?: string | null;
  /** Tests inject a fixed context builder result; production builds from the live scorecard. */
  contextOverride?: AskContext;
}): Promise<AskResult> {
  const question = params.question.trim().slice(0, 500);
  if (!question) return { ok: false, reportId: null, question, answer: null, citations: [], period: null, model: null, generatedAt: null, error: 'Ask a question first.' };

  const config = await getAnthropicConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, reportId: null, question, answer: null, citations: [], period: null, model: null, generatedAt: null, error: 'Anthropic not configured' };
  }

  const limit = checkAskRateLimit();
  if (!limit.ok) {
    return { ok: false, rateLimited: true, retryAfterSec: limit.retryAfterSec, reportId: null, question, answer: null, citations: [], period: null, model: null, generatedAt: null, error: `Rate limit: ${ASK_RATE_LIMIT} questions per minute. Try again in ${limit.retryAfterSec}s.` };
  }

  const result = await getScorecard({ range: params.range ?? 'this_week', compare: params.compare ?? 'previous_period', start: params.start, end: params.end });
  const context = params.contextOverride ?? buildAskContext(result);
  const period = { start: result.range.start, end: result.range.end, label: result.range.resolvedLabel, preset: result.range.preset };

  const answer = await askClaude({
    system: ASK_SYSTEM,
    user: `Question: ${question}\n\nContext (JSON):\n${JSON.stringify(context)}`,
    inputSchema: ASK_TOOL_SCHEMA as unknown as Record<string, unknown>,
    schema: AskAnswerSchema,
    toolName: 'submit_answer',
    maxTokens: 1200,
  });
  if (!answer.ok || !answer.data) {
    return { ok: false, notConfigured: answer.notConfigured, reportId: null, question, answer: null, citations: [], period, model: answer.model, generatedAt: null, error: answer.error };
  }

  const grounding = verifyAnswerNumbers(answer.data.answer, answer.data.citations, context);
  if (!grounding.ok) {
    return {
      ok: false,
      reportId: null,
      question,
      answer: null,
      citations: [],
      period,
      model: answer.model,
      generatedAt: null,
      error: `The answer cited numbers that are not in the dashboard data (${grounding.unknown.slice(0, 5).join(', ')}) and was discarded. Ask again, or narrow the question.`,
    };
  }

  const content: AskContent = {
    question,
    answer: answer.data.answer.trim(),
    citations: answer.data.citations,
    period,
    comparison: result.comparison.range ? { start: result.comparison.range.start, end: result.comparison.range.end, label: result.comparison.range.resolvedLabel } : null,
    contextHash: hashAskContext(context),
    generatedAt: new Date().toISOString(),
    model: answer.model ?? config.model,
    usage: answer.usage,
  };
  const [row] = await db
    .insert(aiReports)
    .values({ kind: 'ask', periodStart: period.start, periodEnd: period.end, model: content.model, inputHash: content.contextHash, content: content as unknown as Record<string, unknown> })
    .returning({ id: aiReports.id });

  return { ok: true, reportId: row.id, question, answer: content.answer, citations: content.citations, period, model: content.model, generatedAt: content.generatedAt };
}

export interface AskHistoryItem {
  id: string;
  question: string;
  answer: string;
  citations: AskAnswer['citations'];
  period: AskContent['period'];
  model: string | null;
  generatedAt: string;
}

export async function listAskHistory(limit = 20): Promise<AskHistoryItem[]> {
  const rows = await db.select().from(aiReports).where(eq(aiReports.kind, 'ask')).orderBy(desc(aiReports.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => {
    const c = r.content as unknown as AskContent;
    return { id: r.id, question: c.question, answer: c.answer, citations: c.citations ?? [], period: c.period, model: r.model, generatedAt: c.generatedAt ?? r.createdAt.toISOString() };
  });
}
