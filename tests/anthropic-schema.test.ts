/**
 * Contract test for strict tool use (2026-09-30 production 400: "For 'array'
 * type, property 'maxItems' is not supported"). The unit tests mocked fetch
 * and never saw the API's schema rules; this one asserts the rules on what we
 * actually SEND — the sanitized schema of every tool, and the wire body of a
 * real askClaude request — so adding maxItems / minimum / maxLength to a
 * strict tool fails CI instead of production.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { z } from 'zod';
import { runMigrations } from '@/db/migrate';
import { setSetting } from '@/lib/settings';
import * as prompts from '@/lib/anthropic/prompts';
import { ANTHROPIC_KEYS, MODEL_OPTIONS } from '@/lib/anthropic/config';
import { askClaude } from '@/lib/anthropic/client';
import { toStrictToolSchema, findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';
import { InsightsAnswerSchema } from '@/lib/metrics/insights';
import { AskAnswerSchema } from '@/lib/metrics/ask';
import { RemapSchema } from '@/lib/anthropic/remap';

const TOOL_SCHEMAS = Object.entries(prompts).filter(([name]) => name.endsWith('_TOOL_SCHEMA')) as Array<[string, Record<string, unknown>]>;

describe('every strict tool schema, sanitized', () => {
  it('covers the four features (a new *_TOOL_SCHEMA is picked up automatically)', () => {
    expect(TOOL_SCHEMAS.map(([n]) => n).sort()).toEqual(['ASK_TOOL_SCHEMA', 'INSIGHTS_TOOL_SCHEMA', 'NARRATIVE_TOOL_SCHEMA', 'REMAP_TOOL_SCHEMA']);
  });

  it.each(TOOL_SCHEMAS)('%s has no keyword strict mode rejects, and every object is closed with all fields required', (_name, schema) => {
    expect(findUnsupportedKeywords(toStrictToolSchema(schema))).toEqual([]);
  });

  it('the raw schemas DO carry the real limits (so the sanitizer is what makes them sendable)', () => {
    expect(findUnsupportedKeywords(prompts.INSIGHTS_TOOL_SCHEMA)).toContain('$.properties.findings.maxItems');
    expect(findUnsupportedKeywords(prompts.ASK_TOOL_SCHEMA)).toContain('$.properties.citations.maxItems');
    expect(findUnsupportedKeywords(prompts.REMAP_TOOL_SCHEMA)).toEqual(expect.arrayContaining(['$.properties.confidence.minimum', '$.properties.confidence.maximum']));
  });

  it('moves each removed limit into the field description and leaves the source constant untouched', () => {
    const s = toStrictToolSchema(prompts.INSIGHTS_TOOL_SCHEMA) as { properties: { findings: { description: string; items: { properties: { title: { description: string } } } } } };
    expect(s.properties.findings.description).toContain('at most 3 items');
    expect(s.properties.findings.items.properties.title.description).toBe('Headline with the key number. Constraints: at most 90 characters.');
    const r = toStrictToolSchema(prompts.REMAP_TOOL_SCHEMA) as { properties: { confidence: { description: string } } };
    expect(r.properties.confidence.description).toBe('Constraints: minimum 0; maximum 1.');
    expect(prompts.INSIGHTS_TOOL_SCHEMA.properties.findings.maxItems).toBe(3);
  });

  it('closes open objects, drops unsupported formats and minItems > 1, keeps minItems 0/1 and supported formats', () => {
    const s = toStrictToolSchema({
      type: 'object',
      properties: {
        a: { type: 'array', minItems: 2, items: { type: 'object', properties: { x: { type: 'string', format: 'phone' }, y: { type: 'string', format: 'email' } } } },
        b: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^a' } },
      },
    });
    expect(findUnsupportedKeywords(s)).toEqual([]);
    expect(s).toMatchObject({ additionalProperties: false, required: ['a', 'b'] });
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.a.minItems).toBeUndefined();
    expect(props.b.minItems).toBe(1);
    expect((props.a.items as { properties: Record<string, Record<string, unknown>> }).properties.y.format).toBe('email');
    expect((props.a.items as { properties: Record<string, Record<string, unknown>> }).properties.x.format).toBeUndefined();
  });
});

describe('the wire request askClaude sends', () => {
  const fetchSpy = vi.fn();
  beforeAll(async () => {
    await runMigrations();
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-contract-test-0000', { secret: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it.each(TOOL_SCHEMAS)('%s → body.tools[0] is strict and its input_schema passes the contract', async (_name, schema) => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 't', name: 'submit', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await askClaude({ system: 's', user: 'u', inputSchema: schema, schema: z.unknown(), toolName: 'submit' });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools[0].strict).toBe(true);
    expect(findUnsupportedKeywords(body.tools[0].input_schema)).toEqual([]);
  });

  it('an API error carries the status and request id, never the key', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: "tools.0.custom: For 'array' type, property 'maxItems' is not supported" } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_contract_1' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const r = await askClaude({ system: 's', user: 'u', inputSchema: prompts.NARRATIVE_TOOL_SCHEMA, schema: z.unknown() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Anthropic 400 · invalid_request_error: /);
    expect(r.error).toContain('req_contract_1');
    expect(r.error).not.toContain('sk-ant-contract-test-0000');
  });
});

describe('response side keeps the limits', () => {
  const finding = { title: 't', detail: 'd', metric: 'cac', direction: 'up', severity: 'info', link: '/ads' };
  it('trims 5 findings to 3 and 40 citations to 30 instead of failing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = InsightsAnswerSchema.safeParse({ findings: Array(5).fill(finding) });
    expect(f.success && f.data.findings).toHaveLength(3);
    const a = AskAnswerSchema.safeParse({ answer: 'x', citations: Array(40).fill({ label: 'l', value: 1, path: 'p' }) });
    expect(a.success && a.data.citations).toHaveLength(30);
    expect(warn).toHaveBeenCalledWith('[anthropic] trimmed 5 findings to 3');
    warn.mockRestore();
  });

  it('clamps remap confidence to 0–1', () => {
    expect(RemapSchema.parse({ role: 'applied', confidence: 1.4, rationale: 'r' }).confidence).toBe(1);
    expect(RemapSchema.parse({ role: 'applied', confidence: -0.2, rationale: 'r' }).confidence).toBe(0);
  });

  it('other violations still fail (an over-long title is not silently accepted)', () => {
    expect(InsightsAnswerSchema.safeParse({ findings: [{ ...finding, title: 'x'.repeat(91) }] }).success).toBe(false);
  });
});

// Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject forced tool_choice {type:'tool'}, which askClaude sends. Offering one of
// them in Setup would 400 every feature — this fails until askClaude handles tool_choice 'auto' for those models.
const ACCEPTS_FORCED_TOOL_CHOICE = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];
describe('model options', () => {
  it('every selectable model accepts the forced tool_choice askClaude sends', () => {
    for (const m of MODEL_OPTIONS) expect(ACCEPTS_FORCED_TOOL_CHOICE, m).toContain(m);
  });
});
