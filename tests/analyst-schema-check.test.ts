/**
 * The free live schema check (2026-09-30): it sends the EXACT production prompt — the contract, the
 * brief, all 15 tools and the answer schema as a strict tool — to count_tokens, and reports the
 * API's own message when a schema is rejected.
 */
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { checkAnalystSchemasLive, formatSchemaLine, productionRequestForBudget } from '@/lib/analyst/schemaCheck';
import { ANSWER_SCHEMA } from '@/lib/analyst/schema';
import { ANALYST_TOOL_DEFINITIONS } from '@/lib/analyst/tools';
import { ANALYST_CONTRACT } from '@/lib/analyst/prompts';
import { SUBMIT_ANSWER_TOOL } from '@/lib/analyst/api';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';

describe('checkAnalystSchemasLive', () => {
  it('sends the production tools + the answer schema (strict) + the contract + the brief to count_tokens, per model', async () => {
    const counted: Array<Record<string, unknown>> = [];
    const created: Array<Record<string, unknown>> = [];
    const client = {
      beta: {
        messages: {
          countTokens: async (p: Record<string, unknown>) => (counted.push(p), { input_tokens: 21_340 }),
          create: async (p: Record<string, unknown>) => (created.push(p), { stop_reason: 'max_tokens', usage: { input_tokens: 21_400, output_tokens: 64 } }),
        },
      },
    } as unknown as Anthropic;
    const lines = await checkAnalystSchemasLive({ key: 'k', brief: 'THE BRIEF', client });
    expect(lines.map((l) => [l.model, l.ok, l.step, l.inputTokens])).toEqual([['claude-opus-5-5', true, 'messages.create', 21_340], ['claude-fable-5-1', true, 'messages.create', 21_340]]);
    expect(formatSchemaLine(lines[0])).toBe('PASS production schemas · claude-opus-5-5 · schema budget ok · 15/20 strict tools · 0/24 optional · 0/16 unions · count_tokens 21,340 tokens · messages.create accepted the exact production request (stop max_tokens) · $0.09 USD');
    // The real request: the production tools, the answer schema as output_config.format, tool_choice auto, small max_tokens.
    const req = created[0] as { tools: Array<{ name: string; strict?: boolean }>; system: Array<{ text: string }>; max_tokens: number; tool_choice: unknown; output_config: { format: { schema: unknown } } };
    expect(req.tools.map((t) => t.name)).toEqual(ANALYST_TOOL_DEFINITIONS.map((t) => t.name));
    expect(req.tools.every((t) => t.strict)).toBe(true);
    expect(req.system.map((s) => s.text)).toEqual([ANALYST_CONTRACT, 'THE BRIEF']);
    expect(req.max_tokens).toBe(64);
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect(req.output_config.format.schema).toEqual(ANSWER_SCHEMA);
    expect(JSON.stringify(req)).not.toMatch(/"type":\[/); // no union types anywhere in the production request
    expect((counted[0] as { tools: unknown[] }).tools.length).toBe(15);
    for (const t of productionRequestForBudget('submit_answer').tools) expect(findUnsupportedKeywords(t.input_schema as Record<string, unknown>), t.name).toEqual([]);
    expect(productionRequestForBudget('submit_answer').tools.map((t) => t.name)).toContain(SUBMIT_ANSWER_TOOL);
  });
  it('reports the API\'s exact message on a rejected schema', async () => {
    const client = {
      beta: {
        messages: {
          countTokens: async () => {
            throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: "tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string', 'null']'" }, request_id: 'req_011CfaVWUZmZ5ZBMEAokRMnQ' }, '400', new Headers());
          },
        },
      },
    } as unknown as Anthropic;
    const [line] = await checkAnalystSchemasLive({ key: 'k', brief: 'b', models: ['claude-opus-5-5'], client });
    expect(line).toMatchObject({ ok: false, step: 'count_tokens' });
    expect(formatSchemaLine(line)).toBe("FAIL production schemas · claude-opus-5-5 · schema budget ok · 15/20 strict tools · 0/24 optional · 0/16 unions · count_tokens rejected the schemas: Anthropic 400 · invalid_request_error: tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string', 'null']' (request_id req_011CfaVWUZmZ5ZBMEAokRMnQ)");
  });
  it('count_tokens is not sufficient: a rejection by messages.create is reported as that step, with the exact message', async () => {
    const client = {
      beta: {
        messages: {
          countTokens: async () => ({ input_tokens: 21_340 }),
          create: async () => {
            throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Schemas contains too many parameters with union types (40 parameters with type arrays or anyOf)... limit: 16 parameters with unions.' }, request_id: 'req_011CfaWR1ESRvqn1q6it4tdF' }, '400', new Headers());
          },
        },
      },
    } as unknown as Anthropic;
    const [line] = await checkAnalystSchemasLive({ key: 'k', brief: 'b', models: ['claude-opus-5-5'], client });
    expect(line).toMatchObject({ ok: false, step: 'messages.create', inputTokens: 21_340, costUsd: 0 });
    expect(formatSchemaLine(line)).toContain('messages.create REJECTED the production request: Anthropic 400 · invalid_request_error: Schemas contains too many parameters with union types');
  });
});
