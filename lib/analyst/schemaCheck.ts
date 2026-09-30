/**
 * The live schema check (2026-09-30, twice burnt). The first `npm run smoke:analyst` 400'd on a
 * nullable enum the unit tests accepted; the second 400'd on the per-request limit (40 union-typed
 * parameters, limit 16) that `count_tokens` had ACCEPTED — count_tokens is not a sufficient check.
 *
 * Three steps, in order, on the EXACT production prompt (the contract, the current brief, all 15
 * tools, the answer schema as `output_config.format`):
 *   1. static — `auditRequestBudget` (lib/anthropic/schemaBudget.ts): the documented limits and
 *      keyword rules, in code, with the offending paths;
 *   2. count_tokens — free; catches the grammar errors it does catch (secondary);
 *   3. ONE real `messages.create` with `max_tokens` small and `tool_choice: auto` — the endpoint
 *      that actually compiles the schemas. Its cost is reported (a few cents).
 * Wired into `npm run check:schemas`, the probe's first lines and Setup → Analyst → Verify. A schema
 * the API rejects fails HERE with the exact API message, never first at a user's question.
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

export interface SchemaCheckLine {
  ok: boolean;
  model: string;
  /** static | count_tokens | messages.create — the step that failed, or 'messages.create' when all passed. */
  step: 'static' | 'count_tokens' | 'messages.create';
  budget: RequestBudget;
  inputTokens: number | null;
  costUsd: number;
  message: string;
}

/** The production request the check audits statically: the tool list and the answer schema in the given mode. */
export function productionRequestForBudget(answerMode: AnswerMode = 'format'): { tools: BetaTool[]; format: { schema: unknown } | null } {
  const tools: BetaTool[] = answerMode === 'submit_answer' ? [...ANALYST_TOOL_DEFINITIONS, { name: SUBMIT_ANSWER_TOOL, description: 'Submit the final answer.', input_schema: ANSWER_SCHEMA as unknown as BetaTool['input_schema'], strict: true }] : [...ANALYST_TOOL_DEFINITIONS];
  return { tools, format: answerMode === 'format' ? { schema: ANSWER_SCHEMA } : null };
}

const CHECK_QUESTION = 'Schema check. Answer with kind "clarify" and the clarifying question "Which period?" — call no tool.';

export async function checkAnalystSchemasLive(opts: { key: string; brief: string; models?: readonly AnalystModel[]; answerMode?: AnswerMode; client?: Anthropic }): Promise<SchemaCheckLine[]> {
  const answerMode = opts.answerMode ?? 'format';
  const budget = auditRequestBudget(productionRequestForBudget(answerMode));
  const out: SchemaCheckLine[] = [];
  const models = opts.models ?? ANALYST_MODEL_OPTIONS;
  if (!budget.ok) {
    for (const model of models) out.push({ ok: false, model, step: 'static', budget, inputTokens: null, costUsd: 0, message: budget.message });
    return out;
  }
  const client = opts.client ?? makeAnalystClient(opts.key);
  for (const model of models) {
    let inputTokens: number | null = null;
    try {
      const count = await client.beta.messages.countTokens(buildCountRequest({ model, system: [ANALYST_CONTRACT, opts.brief], tools: productionRequestForBudget(answerMode).tools, messages: [{ role: 'user', content: CHECK_QUESTION }] }));
      inputTokens = count.input_tokens;
    } catch (err) {
      out.push({ ok: false, model, step: 'count_tokens', budget, inputTokens: null, costUsd: 0, message: `${budget.message} · count_tokens rejected the schemas: ${describeError(err)}` });
      continue;
    }
    try {
      const req = buildTurnRequest({ model, effort: 'low', system: [ANALYST_CONTRACT, opts.brief], tools: [...ANALYST_TOOL_DEFINITIONS], messages: [{ role: 'user', content: CHECK_QUESTION }], answerSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode, maxTokens: 64 });
      const res = await client.beta.messages.create(req);
      const costUsd = priceUsage(model, res.usage as unknown as UsageLike);
      out.push({ ok: true, model, step: 'messages.create', budget, inputTokens, costUsd, message: `${budget.message} · count_tokens ${inputTokens.toLocaleString('en-US')} tokens · messages.create accepted the exact production request (stop ${res.stop_reason}) · ${formatUsd(costUsd)}` });
    } catch (err) {
      out.push({ ok: false, model, step: 'messages.create', budget, inputTokens, costUsd: 0, message: `${budget.message} · count_tokens ${inputTokens.toLocaleString('en-US')} tokens · messages.create REJECTED the production request: ${describeError(err)}` });
    }
  }
  return out;
}

export function formatSchemaLine(l: SchemaCheckLine): string {
  return `${l.ok ? 'PASS' : 'FAIL'} production schemas · ${l.model} · ${l.message}`;
}
