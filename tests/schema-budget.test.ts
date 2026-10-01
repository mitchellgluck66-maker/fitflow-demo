/**
 * The per-request schema budget (2026-09-30): the documented limits — 20 strict tools, 24 optional and
 * 16 union-typed parameters across every strict tool + the output format — counted in code, and the
 * production requests (the Analyst's and askClaude's) proven under them with the counts.
 */
import { describe, it, expect } from 'vitest';
import { auditRequestBudget, assertRequestBudget, countSchema, SCHEMA_LIMITS, SchemaBudgetError } from '@/lib/anthropic/schemaBudget';
import { productionRequestForBudget } from '@/lib/analyst/schemaCheck';
import { buildTurnRequest, type BetaTool } from '@/lib/analyst/api';
import { ANALYST_TOOL_DEFINITIONS } from '@/lib/analyst/tools';
import { ANSWER_SCHEMA } from '@/lib/analyst/schema';
import { toStrictToolSchema } from '@/lib/anthropic/strictSchema';
import * as prompts from '@/lib/anthropic/prompts';
import { VERIFY_TOOL_SCHEMA } from '@/lib/anthropic/client';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

describe('countSchema', () => {
  it('counts optional (not in required, any depth) and union (anyOf / type arrays, any depth) parameters by path', () => {
    const schema = obj({ a: { type: 'string' }, b: { anyOf: [{ type: 'string' }, { type: 'null' }] }, c: { type: ['number', 'null'] }, nested: obj({ d: { type: 'string' }, e: { type: 'integer' } }, ['d']), list: { type: 'array', items: obj({ f: { type: ['string', 'null'] } }) } }, ['a', 'b', 'c', 'nested']);
    const c = countSchema(schema, 'tool x');
    expect(c.optional).toEqual(['tool x.properties.nested.properties.e', 'tool x.properties.list']);
    expect(c.unions).toEqual(['tool x.properties.b', 'tool x.properties.c', 'tool x.properties.list.items.properties.f']);
    expect(c.oneOf).toEqual([]);
    expect(countSchema({ oneOf: [{ type: 'string' }] }).oneOf).toEqual(['$']);
  });
});

describe('auditRequestBudget', () => {
  it('the second smoke:analyst 400 (40 unions) is refused in code with the paths', () => {
    const range = obj({ preset: { anyOf: [{ type: 'string', enum: ['today'] }, { type: 'null' }] }, start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] } });
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, strict: true, input_schema: obj({ range }) }));
    const b = auditRequestBudget({ tools, format: null });
    expect(b.ok).toBe(false);
    expect(b.unionParams).toBe(30);
    expect(b.problems[0]).toMatch(/^30 union-typed parameters \(anyOf \/ type arrays\), limit 16: tool t0\.properties\.range\.properties\.preset, /);
    expect(b.message).toMatch(/^schema budget exceeded · 10\/20 strict tools · 0\/24 optional · 30\/16 unions — /);
    expect(() => assertRequestBudget({ tools })).toThrow(SchemaBudgetError);
    expect(() => assertRequestBudget({ tools })).toThrow(/^Request not sent: schema budget exceeded/);
  });
  it('counts across tools AND the output format; non-strict tools do not count; too many strict tools and optionals are named', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, strict: true, input_schema: obj({ a: { type: 'string' } }) }));
    expect(auditRequestBudget({ tools: many }).problems).toContain('21 strict tools, limit 20');
    const optionals = obj(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: 'string' }])), []);
    expect(auditRequestBudget({ tools: [], format: { schema: optionals } }).problems[0]).toMatch(/^25 optional parameters, limit 24: output_config\.format\.properties\.p0/);
    const lax = auditRequestBudget({ tools: [{ name: 'loose', strict: false, input_schema: optionals }] });
    expect(lax).toMatchObject({ ok: true, strictTools: 0, optionalParams: 0 });
    expect(auditRequestBudget({ tools: [{ name: 'k', strict: true, input_schema: obj({ a: { type: 'string', maxLength: 3 } }) }] }).problems[0]).toMatch(/maxLength: unsupported/);
  });
});

describe('the production requests are under budget', () => {
  it('the Analyst: 0 strict tools (only the answer schema is strict), 0 optional, 0 unions, in both answer modes — and buildTurnRequest agrees', () => {
    const fmt = auditRequestBudget(productionRequestForBudget('format'));
    expect(fmt).toMatchObject({ ok: true, strictTools: 0, optionalParams: 0, unionParams: 0 });
    expect(fmt.message).toBe('schema budget ok · 0/20 strict tools · 0/24 optional · 0/16 unions');
    const sub = auditRequestBudget(productionRequestForBudget('submit_answer'));
    expect(sub).toMatchObject({ ok: true, strictTools: 1, optionalParams: 0, unionParams: 0 });
    expect(SCHEMA_LIMITS).toEqual({ strictTools: 20, optionalParams: 24, unionParams: 16 });
    // The builder refuses an over-budget request before it exists.
    const bad: BetaTool[] = [...ANALYST_TOOL_DEFINITIONS, { name: 'zz_bad', description: 'x', strict: true, input_schema: obj(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`u${i}`, { type: ['string', 'null'] }]))) as BetaTool['input_schema'] }];
    expect(() => buildTurnRequest({ model: 'claude-opus-5-5', effort: 'high', system: ['c', 'b'], tools: bad, messages: [{ role: 'user', content: 'hi' }], answerSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode: 'format', maxTokens: 10 })).toThrow(/^Request not sent: schema budget exceeded · 1\/20 strict tools · 0\/24 optional · 17\/16 unions/);
  });
  it("askClaude's one strict tool per feature is under budget after the sanitizer", () => {
    for (const [name, schema] of [...Object.entries(prompts).filter(([n]) => n.endsWith('_TOOL_SCHEMA')), ['VERIFY_TOOL_SCHEMA', VERIFY_TOOL_SCHEMA]] as Array<[string, Record<string, unknown>]>) {
      const b = auditRequestBudget({ tools: [{ name, strict: true, input_schema: toStrictToolSchema(schema) }] });
      expect(b.ok, `${name}: ${b.message}`).toBe(true);
      expect(b.optionalParams, name).toBe(0);
    }
  });
});
