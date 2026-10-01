/**
 * The live schema check (2026-09-30, three 400s in a row). Grammar size has no documented number,
 * so the check MEASURES instead of guessing, by bisecting real `messages.create` calls on the exact
 * production prompt (the contract, the current brief, the 15 tools, the answer schema):
 *
 *   static           the per-request budget in code (lib/anthropic/schemaBudget.ts) — free
 *   count_tokens     the free secondary check (it does not compile grammars)
 *   answer_alone     output_config.format with NO tools — is the answer schema itself compilable?
 *   production       the real request: the answer (strict) + the 15 NON-strict tools
 *   strict_capacity  informational: how many of the tools could be strict alongside the answer
 *                    (binary search over the name-sorted list; ≤ 4 extra requests)
 *
 * Each real request uses max_tokens 64 and tool_choice auto; its cost (a few cents) is reported.
 * Wired into `npm run check:schemas` (every step), the probe's first lines (static, answer_alone,
 * production) and Setup → Analyst → Verify (static, count_tokens, production). A schema the API
 * rejects fails HERE with the exact API message and the step that failed, never first at a user's
 * question.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describeError } from '../anthropic/client';
import { auditRequestBudget, type RequestBudget } from '../anthropic/schemaBudget';
import { ANALYST_MODEL_OPTIONS, type AnalystModel, type AnswerMode } from './config';
import { buildCountRequest, buildTurnRequest, makeAnalystClient, SUBMIT_ANSWER_TOOL, type BetaTool } from './api';
import { ANALYST_TOOL_DEFINITIONS } from './tools';
import { ANSWER_SCHEMA } from './schema';
import { ANALYST_CONTRACT } from './prompts';
import { formatUsd, priceUsage, type UsageLike } from './cost';

export type SchemaStep = 'static' | 'count_tokens' | 'answer_alone' | 'production' | 'strict_capacity';

export interface SchemaCheckLine {
  ok: boolean;
  model: string;
  step: SchemaStep;
  budget: RequestBudget;
  inputTokens: number | null;
  costUsd: number;
  message: string;
}

/** The production request the check audits statically: the 15 non-strict tools and the answer schema (strict). */
export function productionRequestForBudget(answerMode: AnswerMode = 'format'): { tools: BetaTool[]; format: { schema: unknown } | null } {
  const tools: BetaTool[] = answerMode === 'submit_answer' ? [...ANALYST_TOOL_DEFINITIONS, { name: SUBMIT_ANSWER_TOOL, description: 'Submit the final answer.', input_schema: ANSWER_SCHEMA as unknown as BetaTool['input_schema'], strict: true }] : [...ANALYST_TOOL_DEFINITIONS];
  return { tools, format: answerMode === 'format' ? { schema: ANSWER_SCHEMA } : null };
}

const CHECK_QUESTION = 'Schema check. Answer with kind "clarify" and the clarifying question "Which period?" — call no tool.';

export interface SchemaCheckOptions {
  key: string;
  brief: string;
  models?: readonly AnalystModel[];
  answerMode?: AnswerMode;
  /** verify = static + count_tokens + production; probe = + answer_alone; full = + strict_capacity. */
  scope?: 'verify' | 'probe' | 'full';
  client?: Anthropic;
}

export async function checkAnalystSchemasLive(opts: SchemaCheckOptions): Promise<SchemaCheckLine[]> {
  const answerMode = opts.answerMode ?? 'format';
  const scope = opts.scope ?? 'verify';
  const budget = auditRequestBudget(productionRequestForBudget(answerMode));
  const out: SchemaCheckLine[] = [];
  const models = opts.models ?? ANALYST_MODEL_OPTIONS;
  if (!budget.ok) {
    for (const model of models) out.push({ ok: false, model, step: 'static', budget, inputTokens: null, costUsd: 0, message: budget.message });
    return out;
  }
  const client = opts.client ?? makeAnalystClient(opts.key);
  const system: [string, string] = [ANALYST_CONTRACT, opts.brief];
  const messages = [{ role: 'user' as const, content: CHECK_QUESTION }];
  const schema = ANSWER_SCHEMA as unknown as Record<string, unknown>;

  /** One real request; returns the line pieces. */
  const attempt = async (model: AnalystModel, tools: BetaTool[]): Promise<{ ok: boolean; costUsd: number; detail: string }> => {
    try {
      const res = await client.beta.messages.create(buildTurnRequest({ model, effort: 'low', system, tools, messages, answerSchema: schema, answerMode, maxTokens: 64 }));
      const costUsd = priceUsage(model, res.usage as unknown as UsageLike);
      return { ok: true, costUsd, detail: `accepted (stop ${res.stop_reason}) · ${formatUsd(costUsd)}` };
    } catch (err) {
      return { ok: false, costUsd: 0, detail: `REJECTED: ${describeError(err)}` };
    }
  };

  for (const model of models) {
    let inputTokens: number | null = null;
    if (scope !== 'probe') {
      try {
        const count = await client.beta.messages.countTokens(buildCountRequest({ model, system, tools: productionRequestForBudget(answerMode).tools, messages }));
        inputTokens = count.input_tokens;
        out.push({ ok: true, model, step: 'count_tokens', budget, inputTokens, costUsd: 0, message: `${budget.message} · count_tokens accepted the production prompt · ${inputTokens.toLocaleString('en-US')} input tokens (secondary — it does not compile grammars)` });
      } catch (err) {
        out.push({ ok: false, model, step: 'count_tokens', budget, inputTokens: null, costUsd: 0, message: `${budget.message} · count_tokens rejected the production prompt: ${describeError(err)}` });
      }
    }
    if (scope !== 'verify') {
      const alone = await attempt(model, []);
      out.push({ ok: alone.ok, model, step: 'answer_alone', budget, inputTokens, costUsd: alone.costUsd, message: `answer schema alone (output_config.format, no tools) · ${alone.detail}` });
    }
    const tools = productionRequestForBudget(answerMode).tools;
    const prod = await attempt(model, tools);
    out.push({ ok: prod.ok, model, step: 'production', budget, inputTokens, costUsd: prod.costUsd, message: `${budget.message} · the production request (answer schema strict + ${ANALYST_TOOL_DEFINITIONS.length} non-strict tools) · ${prod.detail}` });
    if (scope === 'full') {
      // Binary search the largest k such that the first k tools (name order) can be strict alongside the answer.
      let lo = 0;
      let hi = ANALYST_TOOL_DEFINITIONS.length;
      let cost = 0;
      const tried: string[] = [];
      while (lo < hi) {
        const k = Math.ceil((lo + hi) / 2);
        const r = await attempt(model, [...ANALYST_TOOL_DEFINITIONS].sort((a, b) => a.name.localeCompare(b.name)).map((t, i) => ({ ...t, strict: i < k })));
        cost += r.costUsd;
        tried.push(`${k}:${r.ok ? 'ok' : 'rejected'}`);
        if (r.ok) lo = k;
        else hi = k - 1;
      }
      out.push({ ok: true, model, step: 'strict_capacity', budget, inputTokens, costUsd: cost, message: `informational: ${lo} of ${ANALYST_TOOL_DEFINITIONS.length} tools can be strict alongside the answer (binary search ${tried.join(', ')}) · ${formatUsd(cost)}` });
    }
  }
  return out;
}

export function formatSchemaLine(l: SchemaCheckLine): string {
  return `${l.ok ? 'PASS' : 'FAIL'} ${l.step} · ${l.model} · ${l.message}`;
}
