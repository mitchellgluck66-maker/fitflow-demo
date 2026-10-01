/**
 * The tool-input validator derived from each tool's JSON Schema (2026-09-30: the 15 read tools are
 * not strict, so the server validates). Every production tool converts; a bad input becomes a readable
 * error result the model can correct; a malformed schema fails at build time.
 */
import { describe, it, expect } from 'vitest';
import { zodFromJsonSchema, describeZodIssues } from '@/lib/anthropic/jsonSchemaToZod';
import { ANALYST_TOOLS, runAnalystTool, type Freshness, type ToolContext } from '@/lib/analyst/tools';

const freshness: Freshness = { stale: false, line: 'test', sources: [] };
const ctx: ToolContext = { ref: 'r1', freshness, resolveRef: () => undefined };

describe('zodFromJsonSchema', () => {
  it('converts the subset we use and rejects unknown keys, wrong types and bad enum values with paths', () => {
    const z = zodFromJsonSchema({ type: 'object', properties: { range: { type: 'object', properties: { preset: { type: 'string', enum: ['last_week', 'custom'] }, start: { type: 'string' } }, required: ['preset', 'start'], additionalProperties: false }, page: { type: 'integer' }, flag: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }, list: { type: 'array', items: { type: 'number' } } }, required: ['range', 'page', 'flag', 'list'], additionalProperties: false });
    expect(z.safeParse({ range: { preset: 'last_week', start: '' }, page: 1, flag: null, list: [1] }).success).toBe(true);
    const bad = z.safeParse({ range: { preset: 'lastweek', start: '' }, page: 1.5, flag: 'x', list: [1], extra: 1 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const text = describeZodIssues(bad.error);
      expect(text).toContain('range.preset: ');
      expect(text).toContain('page: ');
      expect(text).toMatch(/extra/);
    }
  });
  it('every production tool schema converts (an unsupported keyword would throw at build time)', () => {
    for (const t of ANALYST_TOOLS) expect(() => zodFromJsonSchema(t.definition.input_schema, t.definition.name)).not.toThrow();
    expect(() => zodFromJsonSchema({ type: 'object', properties: { x: { type: 'date' } }, required: ['x'], additionalProperties: false })).toThrow(/unsupported schema type "date"/);
  });
});

describe('runAnalystTool validates input (non-strict tools)', () => {
  it('a bad enum / missing field / extra field is an error RESULT naming the path, never a throw, never a silent default', async () => {
    const r1 = await runAnalystTool('get_funnel', { range: { preset: 'lastweek', start: '', end: '' }, mode: 'period' }, ctx);
    expect(r1).toMatchObject({ ref: 'r1', data: null });
    expect(r1.error).toMatch(/^invalid input for get_funnel: range\.preset: .*received "lastweek"|^invalid input for get_funnel: range\.preset: /);
    expect(r1.error).toContain('fix the input and call again');
    const r2 = await runAnalystTool('get_scorecard', { range: { preset: 'last_week', start: '', end: '' } }, ctx); // compare missing
    expect(r2.error).toMatch(/^invalid input for get_scorecard: compare: /);
    const r3 = await runAnalystTool('calculate', { op: 'sum', a: { kind: 'value', ref: '', value: 1 }, b: { kind: 'value', ref: '', value: 2, extra: true } }, ctx);
    expect(r3.error).toMatch(/^invalid input for calculate: b/);
    const r4 = await runAnalystTool('get_trend', { metric: 'enrollments', window: '2y' }, ctx);
    expect(r4.error).toMatch(/^invalid input for get_trend: window: /);
  });
  it('the corrected call then runs (the model can retry from the error text)', async () => {
    const ok = await runAnalystTool('calculate', { op: 'sum', a: { kind: 'value', ref: '', value: 1 }, b: { kind: 'value', ref: '', value: 2 } }, ctx);
    expect(ok.error).toBeUndefined();
    expect(ok.data).toMatchObject({ value: 3 });
  });
});
