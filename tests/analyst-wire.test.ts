/**
 * Wire contract of every Analyst request (plan items 1 and 5). The probe
 * proves these shapes live; this test keeps them from drifting: only adaptive
 * thinking, tool_choice auto, no sampling parameters, each beta header paired
 * with its field, ≤ 4 cache breakpoints, drop_block set, name-sorted strict
 * tools, and a compaction request with no output format.
 */
import { describe, it, expect } from 'vitest';
import { buildCompactionRequest, buildCountRequest, buildTurnRequest, SUBMIT_ANSWER_TOOL, type BetaTool } from '@/lib/analyst/api';
import { ANALYST_BETAS } from '@/lib/analyst/config';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';
import { ANALYST_PRICES, formatUsd, priceUsage, usageTotals } from '@/lib/analyst/cost';
import { ANALYST_TOOL_DEFINITIONS } from '@/lib/analyst/tools';
import { ANSWER_SCHEMA } from '@/lib/analyst/schema';

const tools: BetaTool[] = [
  { name: 'get_scorecard', description: 'b', strict: true, input_schema: { type: 'object', properties: { range: { type: 'string' } }, required: ['range'], additionalProperties: false } },
  { name: 'calculate', description: 'a', strict: true, input_schema: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'], additionalProperties: false } },
];
const schema = { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'], additionalProperties: false };
const base = { model: 'claude-opus-5-5' as const, effort: 'high' as const, system: ['contract', 'brief'] as [string, string], tools, messages: [{ role: 'user' as const, content: 'hi' }], answerSchema: schema, answerMode: 'format' as const, maxTokens: 8000 };

describe('turn request', () => {
  const req = buildTurnRequest(base);
  it('adaptive thinking only, with display updates and drop_block; no sampling parameters; effort explicit', () => {
    expect(req.thinking).toEqual({ type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('top_p');
    expect(req).not.toHaveProperty('top_k');
    expect(req).not.toHaveProperty('stop_sequences');
    expect(req.output_config?.effort).toBe('high');
  });
  it('tool_choice is auto — a forced choice is a 400 on both models', () => {
    expect(req.tool_choice).toEqual({ type: 'auto' });
  });
  it('every beta header is paired with its field, both ways', () => {
    expect(req.betas).toEqual([ANALYST_BETAS.displayUpdates, ANALYST_BETAS.bindingControls]);
    expect((req.thinking as { display?: string }).display).toBe('updates'); // ↔ displayUpdates
    expect((req.thinking as { block_binding?: unknown }).block_binding).toBeDefined(); // ↔ bindingControls
    expect(req).not.toHaveProperty('compaction'); // ↔ no compaction beta
    expect(buildTurnRequest(base, { carriesCompaction: true }).betas).toContain(ANALYST_BETAS.compaction);
  });
  it('at most 4 cache breakpoints: two on system, none elsewhere', () => {
    const sys = req.system as Array<{ cache_control?: unknown }>;
    expect(sys.filter((s) => s.cache_control).length).toBe(2);
    const json = JSON.stringify(req);
    expect((json.match(/"cache_control"/g) ?? []).length).toBeLessThanOrEqual(4);
    expect(json).not.toContain('"ttl"'); // 5-minute TTL only
  });
  it('tools are name-sorted, strict, ≤ 20, with schemas strict mode accepts', () => {
    const names = (req.tools ?? []).map((t) => (t as BetaTool).name);
    expect(names).toEqual([...names].sort());
    expect(names.length).toBeLessThanOrEqual(20);
    for (const t of req.tools ?? []) {
      expect((t as BetaTool).strict).toBe(true);
      expect(findUnsupportedKeywords((t as BetaTool).input_schema as Record<string, unknown>)).toEqual([]);
    }
    expect(() => buildTurnRequest({ ...base, tools: [tools[0], tools[0]] })).toThrow('duplicate tool name');
  });
  it('format mode sends output_config.format with the answer schema and no submit tool', () => {
    expect(req.output_config?.format).toEqual({ type: 'json_schema', schema });
    expect((req.tools ?? []).map((t) => (t as BetaTool).name)).not.toContain(SUBMIT_ANSWER_TOOL);
  });
  it('submit_answer mode sends the same schema as a strict tool, still name-sorted, and no output format', () => {
    const fb = buildTurnRequest({ ...base, answerMode: 'submit_answer' });
    expect(fb.output_config?.format).toBeUndefined();
    const names = (fb.tools ?? []).map((t) => (t as BetaTool).name);
    expect(names).toEqual(['calculate', 'get_scorecard', SUBMIT_ANSWER_TOOL]);
    const submit = (fb.tools ?? []).find((t) => (t as BetaTool).name === SUBMIT_ANSWER_TOOL) as BetaTool;
    expect(submit.strict).toBe(true);
    expect(submit.input_schema).toEqual(schema);
  });
  it('two builds of the same input are string-equal (a byte-identical prefix is what preserved thinking needs)', () => {
    expect(JSON.stringify(buildTurnRequest(base))).toBe(JSON.stringify(buildTurnRequest(base)));
  });
});

describe('schema guard (the 2026-09-30 400)', () => {
  it('rejects enum or const on a union type; accepts the anyOf form and a plain nullable', () => {
    expect(findUnsupportedKeywords({ type: 'object', properties: { preset: { type: ['string', 'null'], enum: ['today', null] } }, required: ['preset'], additionalProperties: false })).toEqual(['$.properties.preset.enum(on union type ["string","null"])']);
    expect(findUnsupportedKeywords({ type: 'object', properties: { k: { type: ['string', 'null'], const: 'x' } }, required: ['k'], additionalProperties: false })).toEqual(['$.properties.k.const(on union type ["string","null"])']);
    expect(findUnsupportedKeywords({ type: 'object', properties: { preset: { anyOf: [{ type: 'string', enum: ['today'] }, { type: 'null' }] }, start: { type: ['string', 'null'] } }, required: ['preset', 'start'], additionalProperties: false })).toEqual([]);
  });
  it('no production tool or the answer schema carries the pattern (the whole list, not tools.1)', () => {
    for (const t of ANALYST_TOOL_DEFINITIONS) expect(findUnsupportedKeywords(t.input_schema as Record<string, unknown>), t.name).toEqual([]);
    expect(findUnsupportedKeywords(ANSWER_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
    expect(JSON.stringify(ANALYST_TOOL_DEFINITIONS)).not.toMatch(/"type":\["string","null"\],"enum"/);
  });
});

describe('compaction request', () => {
  const req = buildCompactionRequest(base, 'keep decisions');
  it('shares system and tools with the turn, carries the compaction beta, and none of the rejected fields', () => {
    const turn = buildTurnRequest(base);
    expect(req.system).toEqual(turn.system);
    expect(req.tools).toEqual(turn.tools);
    expect(req.betas).toContain(ANALYST_BETAS.compaction);
    expect(req.compaction).toEqual({ type: 'summarize', instructions: 'keep decisions' });
    expect(req.output_config?.format).toBeUndefined();
    expect(req).not.toHaveProperty('tool_choice');
    expect(req).not.toHaveProperty('stop_sequences');
    expect(req).not.toHaveProperty('context_management');
  });
});

describe('token count request', () => {
  it('mirrors the turn prompt without output_config (the endpoint does not take it)', () => {
    const req = buildCountRequest(base);
    expect(req.system).toEqual(buildTurnRequest(base).system);
    expect(req).not.toHaveProperty('output_config');
    expect(req).not.toHaveProperty('max_tokens');
  });
});

describe('cost (USD)', () => {
  it('prices both models with cache tiers and compaction iterations; unknown model throws', () => {
    expect(Object.keys(ANALYST_PRICES).sort()).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
    // 1M input on Opus = $4; 1M cache read = $0.20; 1M 5m write = $5; 1M output = $20.
    expect(priceUsage('claude-opus-5-5', { input_tokens: 1_000_000 })).toBe(4);
    expect(priceUsage('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 })).toBe(0.2);
    expect(priceUsage('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000 })).toBe(5);
    expect(priceUsage('claude-opus-5-5', { output_tokens: 1_000_000 })).toBe(20);
    expect(priceUsage('claude-fable-5-1', { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 200_000 })).toBeCloseTo(1 + 0.5 + 0.05, 6);
    // A compaction response: zero at the top, the call in iterations.
    expect(priceUsage('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, iterations: [{ type: 'compaction', input_tokens: 1_000_000, output_tokens: 100_000 }] })).toBe(6);
    // The TTL breakdown wins over the flat count.
    expect(usageTotals({ cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } })).toMatchObject({ cacheWrite5mTokens: 100, cacheWrite1hTokens: 200 });
    expect(() => priceUsage('claude-sonnet-5', { input_tokens: 1 })).toThrow(/No price table/);
  });
  it('formats with the USD label, never "$0.00" for a real spend', () => {
    expect(formatUsd(0.21)).toBe('$0.21 USD');
    expect(formatUsd(0.0032)).toBe('$0.0032 USD');
    expect(formatUsd(0)).toBe('$0.00 USD');
  });
});
