/**
 * The per-request schema budget (2026-09-30, the second smoke:analyst 400). Structured outputs and
 * strict tool use are limited PER REQUEST, counted across every strict tool plus `output_config.format`
 * (docs → Structured outputs → Limits, re-checked 2026-09-30):
 *
 *   - at most 20 strict tools;
 *   - at most 24 optional parameters (a property not in its object's `required`, at any depth);
 *   - at most 16 union-typed parameters (`anyOf`, or a `type` array such as ["string","null"], at any depth);
 *   - no `oneOf`, no recursion, no external `$ref`; `additionalProperties` false on every object; and the
 *     keyword rules `findUnsupportedKeywords` already checks.
 *
 * `count_tokens` accepted a request with 40 unions that `messages.create` then rejected, so the budget is
 * enforced HERE, in code, before any request is built or sent (`assertRequestBudget`), and the contract
 * tests fail on the production Analyst request and on askClaude's. Pure.
 */

import { findUnsupportedKeywords } from './strictSchema';

export const SCHEMA_LIMITS = { strictTools: 20, optionalParams: 24, unionParams: 16 } as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SchemaCounts {
  optional: string[];
  unions: string[];
  oneOf: string[];
  unsupported: string[];
}

/** Count one schema's optional and union parameters (paths), plus the rules the API rejects outright. */
export function countSchema(schema: unknown, path = '$'): SchemaCounts {
  // `findUnsupportedKeywords` also flags a property that is not required (askClaude's all-required convention);
  // the API allows optionals (24 per request), so here they are counted, not rejected.
  const out: SchemaCounts = { optional: [], unions: [], oneOf: [], unsupported: findUnsupportedKeywords(schema, path).filter((f) => !/\.required\([^)]*\)$/.test(f)) };
  const walk = (node: unknown, p: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (!isObj(node)) return;
    if (Array.isArray(node.type) || Array.isArray(node.anyOf)) out.unions.push(p);
    if (Array.isArray(node.oneOf)) out.oneOf.push(p);
    if (isObj(node.properties)) {
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const [k, v] of Object.entries(node.properties)) {
        if (!required.includes(k)) out.optional.push(`${p}.properties.${k}`);
        walk(v, `${p}.properties.${k}`);
      }
    }
    for (const key of ['items', 'anyOf', 'allOf', 'oneOf', '$defs', 'definitions'] as const) if (key in node) walk(node[key], `${p}.${key}`);
  };
  walk(schema, path);
  return out;
}

export interface RequestBudget {
  ok: boolean;
  strictTools: number;
  optionalParams: number;
  unionParams: number;
  limits: typeof SCHEMA_LIMITS;
  /** Every path that counts, so an over-budget request names what to fix. */
  optionalPaths: string[];
  unionPaths: string[];
  problems: string[];
  /** One line for the contract test, the check script and the refused request. */
  message: string;
}

/**
 * Audit a whole request: every strict tool's `input_schema` and the output format's schema.
 * Non-strict tools do not count toward the limits (the API does not compile them).
 */
export function auditRequestBudget(req: { tools?: Array<{ name: string; strict?: boolean | null; input_schema?: unknown }> | null; format?: { schema?: unknown } | null }): RequestBudget {
  const strict = (req.tools ?? []).filter((t) => t.strict);
  const optionalPaths: string[] = [];
  const unionPaths: string[] = [];
  const problems: string[] = [];
  const schemas: Array<[string, unknown]> = strict.map((t) => [`tool ${t.name}`, t.input_schema] as [string, unknown]);
  if (req.format?.schema) schemas.push(['output_config.format', req.format.schema]);
  for (const [label, schema] of schemas) {
    const c = countSchema(schema, label);
    optionalPaths.push(...c.optional);
    unionPaths.push(...c.unions);
    for (const p of c.oneOf) problems.push(`${p}: oneOf is not supported (use anyOf)`);
    for (const p of c.unsupported) problems.push(`${p}: unsupported for strict schemas`);
  }
  if (strict.length > SCHEMA_LIMITS.strictTools) problems.push(`${strict.length} strict tools, limit ${SCHEMA_LIMITS.strictTools}`);
  if (optionalPaths.length > SCHEMA_LIMITS.optionalParams) problems.push(`${optionalPaths.length} optional parameters, limit ${SCHEMA_LIMITS.optionalParams}: ${optionalPaths.join(', ')}`);
  if (unionPaths.length > SCHEMA_LIMITS.unionParams) problems.push(`${unionPaths.length} union-typed parameters (anyOf / type arrays), limit ${SCHEMA_LIMITS.unionParams}: ${unionPaths.join(', ')}`);
  const counts = `${strict.length}/${SCHEMA_LIMITS.strictTools} strict tools · ${optionalPaths.length}/${SCHEMA_LIMITS.optionalParams} optional · ${unionPaths.length}/${SCHEMA_LIMITS.unionParams} unions`;
  return {
    ok: problems.length === 0,
    strictTools: strict.length,
    optionalParams: optionalPaths.length,
    unionParams: unionPaths.length,
    limits: SCHEMA_LIMITS,
    optionalPaths,
    unionPaths,
    problems,
    message: problems.length === 0 ? `schema budget ok · ${counts}` : `schema budget exceeded · ${counts} — ${problems.join('; ')}`,
  };
}

export class SchemaBudgetError extends Error {
  constructor(public readonly budget: RequestBudget) {
    super(`Request not sent: ${budget.message}`);
    this.name = 'SchemaBudgetError';
  }
}

/** Throws before a request that the API would reject; every Anthropic call path calls this first. */
export function assertRequestBudget(req: Parameters<typeof auditRequestBudget>[0]): RequestBudget {
  const b = auditRequestBudget(req);
  if (!b.ok) throw new SchemaBudgetError(b);
  return b;
}
