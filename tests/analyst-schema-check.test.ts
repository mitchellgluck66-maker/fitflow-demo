/**
 * The free live schema check (2026-09-30): it sends the EXACT production prompt — the contract, the
 * brief, all 15 tools and the answer schema as a strict tool — to count_tokens, and reports the
 * API's own message when a schema is rejected.
 */
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { checkAnalystSchemasLive, formatSchemaLine, schemaCheckTools } from '@/lib/analyst/schemaCheck';
import { ANALYST_TOOL_DEFINITIONS } from '@/lib/analyst/tools';
import { ANALYST_CONTRACT } from '@/lib/analyst/prompts';
import { SUBMIT_ANSWER_TOOL } from '@/lib/analyst/api';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';

describe('checkAnalystSchemasLive', () => {
  it('sends the production tools + the answer schema (strict) + the contract + the brief to count_tokens, per model', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = { beta: { messages: { countTokens: async (p: Record<string, unknown>) => (sent.push(p), { input_tokens: 21_340 }) } } } as unknown as Anthropic;
    const lines = await checkAnalystSchemasLive({ key: 'k', brief: 'THE BRIEF', client });
    expect(lines.map((l) => [l.model, l.ok, l.inputTokens])).toEqual([['claude-opus-5-5', true, 21_340], ['claude-fable-5-1', true, 21_340]]);
    expect(formatSchemaLine(lines[0])).toBe('PASS production schemas · claude-opus-5-5 · schemas accepted by count_tokens · 15 tools + the answer schema (as a strict tool) · 21,340 input tokens in the production prompt');
    const req = sent[0] as { tools: Array<{ name: string; strict?: boolean }>; system: Array<{ text: string }>; model: string };
    expect(req.tools.map((t) => t.name)).toEqual([...ANALYST_TOOL_DEFINITIONS.map((t) => t.name), SUBMIT_ANSWER_TOOL].sort());
    expect(req.tools.every((t) => t.strict)).toBe(true);
    expect(req.system.map((s) => s.text)).toEqual([ANALYST_CONTRACT, 'THE BRIEF']);
    expect(JSON.stringify(req.tools)).not.toMatch(/"type":\["string","null"\],"enum"/);
    for (const t of schemaCheckTools()) expect(findUnsupportedKeywords(t.input_schema as Record<string, unknown>), t.name).toEqual([]);
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
    expect(line.ok).toBe(false);
    expect(formatSchemaLine(line)).toBe("FAIL production schemas · claude-opus-5-5 · schema rejected by the API: Anthropic 400 · invalid_request_error: tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string', 'null']' (request_id req_011CfaVWUZmZ5ZBMEAokRMnQ)");
  });
});
