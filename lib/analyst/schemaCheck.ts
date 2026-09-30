/**
 * The FREE live schema check (2026-09-30). `npm run smoke:analyst` failed on its first request with
 * `tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string','null']'`
 * — a shape the unit tests accepted and the probe never sent (it used a sample tool, not the
 * production list). `count_tokens` validates every schema the request carries and costs nothing,
 * so this sends the EXACT production prompt — the contract, the current brief, all 15 tools — and
 * the answer schema as a strict `submit_answer` tool (`count_tokens` takes no `output_config`;
 * strict tools and structured outputs share the same schema rules, so a rejected shape fails here
 * too). Wired into `smoke:analyst --probe` (first line), Setup → Analyst → Verify, and
 * `npm run check:schemas`. A schema the API rejects fails HERE with the exact API message, never
 * first at a user's question.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describeError } from '../anthropic/client';
import { ANALYST_MODEL_OPTIONS, type AnalystModel } from './config';
import { buildCountRequest, makeAnalystClient, SUBMIT_ANSWER_TOOL, type BetaTool } from './api';
import { ANALYST_TOOL_DEFINITIONS } from './tools';
import { ANSWER_SCHEMA } from './schema';
import { ANALYST_CONTRACT } from './prompts';

export interface SchemaCheckLine {
  ok: boolean;
  model: string;
  /** The count endpoint's input tokens for the production prompt (the cached prefix size). */
  inputTokens: number | null;
  message: string;
}

/** The production tool list plus the answer schema as a strict tool — what the check sends. */
export function schemaCheckTools(): BetaTool[] {
  return [...ANALYST_TOOL_DEFINITIONS, { name: SUBMIT_ANSWER_TOOL, description: 'The answer schema, checked as a strict tool.', input_schema: ANSWER_SCHEMA as unknown as BetaTool['input_schema'], strict: true }].sort((a, b) => a.name.localeCompare(b.name));
}

export async function checkAnalystSchemasLive(opts: { key: string; brief: string; models?: readonly AnalystModel[]; client?: Anthropic }): Promise<SchemaCheckLine[]> {
  const client = opts.client ?? makeAnalystClient(opts.key);
  const out: SchemaCheckLine[] = [];
  for (const model of opts.models ?? ANALYST_MODEL_OPTIONS) {
    try {
      const count = await client.beta.messages.countTokens(buildCountRequest({ model, system: [ANALYST_CONTRACT, opts.brief], tools: schemaCheckTools(), messages: [{ role: 'user', content: 'Schema check.' }] }));
      out.push({ ok: true, model, inputTokens: count.input_tokens, message: `schemas accepted by count_tokens · ${ANALYST_TOOL_DEFINITIONS.length} tools + the answer schema (as a strict tool) · ${count.input_tokens.toLocaleString('en-US')} input tokens in the production prompt` });
    } catch (err) {
      out.push({ ok: false, model, inputTokens: null, message: `schema rejected by the API: ${describeError(err)}` });
    }
  }
  return out;
}

export function formatSchemaLine(l: SchemaCheckLine): string {
  return `${l.ok ? 'PASS' : 'FAIL'} production schemas · ${l.model} · ${l.message}`;
}
