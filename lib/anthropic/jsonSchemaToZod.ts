/**
 * JSON Schema → Zod for the subset our tool inputs use (2026-09-30): the API no longer compiles the
 * 15 Analyst read tools (they are `strict: false` — the compiled grammar of 15 strict tools plus the
 * answer was "too large"), so the SERVER validates every tool input against the same JSON Schema the
 * model was shown. One source of truth: the schema in the tool definition; this derives the validator.
 *
 * Supported: object (properties / required / additionalProperties false → strict), string (enum),
 * integer, number, boolean, null, array (items), anyOf. Anything else throws at build time, so an
 * unsupported schema fails the contract test, never a request.
 */

import { z } from 'zod';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function zodFromJsonSchema(schema: unknown, path = '$'): z.ZodTypeAny {
  if (!isObj(schema)) throw new Error(`${path}: not a schema object`);
  if (Array.isArray(schema.anyOf)) return z.union((schema.anyOf as unknown[]).map((s, i) => zodFromJsonSchema(s, `${path}.anyOf[${i}]`)) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  const type = schema.type;
  if (Array.isArray(type)) return z.union((type as string[]).map((t) => zodFromJsonSchema({ ...schema, type: t }, path)) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  switch (type) {
    case 'object': {
      const props = isObj(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        const inner = zodFromJsonSchema(v, `${path}.${k}`);
        shape[k] = required.has(k) ? inner : inner.optional();
      }
      return schema.additionalProperties === false ? z.strictObject(shape) : z.object(shape);
    }
    case 'string': {
      if (Array.isArray(schema.enum)) return z.enum((schema.enum as string[]).filter((v) => typeof v === 'string') as [string, ...string[]]);
      return z.string();
    }
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(zodFromJsonSchema(schema.items, `${path}.items`));
    default:
      throw new Error(`${path}: unsupported schema type ${JSON.stringify(type)}`);
  }
}

/** One readable line per issue: "range.preset: Invalid option: expected one of …, received 'lastweek'". */
export function describeZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(input)'}: ${i.message}`).join('; ');
}
