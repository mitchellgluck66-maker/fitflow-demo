/**
 * Strict tool schemas (2026-09-30 production fix).
 *
 * `askClaude` sends every tool with `strict: true`. Strict tool use rejects
 * several JSON Schema keywords outright — the first live "Ask" returned
 * `Anthropic 400: For 'array' type, property 'maxItems' is not supported`.
 * Documented limits (platform.claude.com → Structured outputs → JSON Schema
 * limitations, re-checked 2026-09-30): no numeric constraints, no string
 * length constraints, no array constraints beyond minItems 0/1, string
 * `format` only from a fixed list, `additionalProperties` must be false.
 *
 * `toStrictToolSchema` does what the SDK helpers do: removes each unsupported
 * constraint, appends it to the field's description (so the model still sees
 * the limit), and forces `additionalProperties: false` + every property
 * required. The Zod schema on the response keeps enforcing the limits.
 * Pure; never mutates its input.
 */

type Json = Record<string, unknown>;

/** Keywords strict mode rejects (or that we do not trust it with). `minItems` and `format` are handled separately. */
export const UNSUPPORTED_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern',
  'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'prefixItems',
  'minProperties', 'maxProperties', 'patternProperties', 'propertyNames',
] as const;

export const SUPPORTED_STRING_FORMATS = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'] as const;

function phrase(key: string, value: unknown): string {
  switch (key) {
    case 'minimum': return `minimum ${value}`;
    case 'maximum': return `maximum ${value}`;
    case 'exclusiveMinimum': return `greater than ${value}`;
    case 'exclusiveMaximum': return `less than ${value}`;
    case 'multipleOf': return `a multiple of ${value}`;
    case 'minLength': return `at least ${value} characters`;
    case 'maxLength': return `at most ${value} characters`;
    case 'pattern': return `matches /${value}/`;
    case 'maxItems': return `at most ${value} items`;
    case 'minItems': return `at least ${value} items`;
    case 'uniqueItems': return value ? 'items must be unique' : '';
    case 'format': return `format ${value}`;
    default: return `${key}: ${JSON.stringify(value)}`;
  }
}

export function toStrictToolSchema<T extends object>(schema: T): Json {
  return walk(schema as unknown as Json);
}

function walk(node: Json): Json {
  const out: Json = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      const p = phrase(key, value);
      if (p) notes.push(p);
      continue;
    }
    if (key === 'minItems' && typeof value === 'number' && value > 1) {
      notes.push(phrase(key, value));
      continue;
    }
    if (key === 'format' && typeof value === 'string' && !(SUPPORTED_STRING_FORMATS as readonly string[]).includes(value)) {
      notes.push(phrase(key, value));
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, isObj(v) ? walk(v) : v]));
    } else if ((key === 'items' || key === 'additionalItems') && isObj(value)) {
      out[key] = walk(value);
    } else if ((key === 'anyOf' || key === 'allOf' || key === 'oneOf') && Array.isArray(value)) {
      out[key] = value.map((v) => (isObj(v) ? walk(v) : v));
    } else if ((key === '$defs' || key === 'definitions') && isObj(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isObj(v) ? walk(v) : v]));
    } else if (Array.isArray(value)) {
      out[key] = [...value];
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object' || isObj(out.properties)) {
    out.additionalProperties = false;
    out.required = Object.keys((out.properties as Json | undefined) ?? {});
  }
  if (notes.length) {
    const base = typeof out.description === 'string' && out.description.trim() ? out.description.trim().replace(/\.?$/, '.') + ' ' : '';
    out.description = `${base}Constraints: ${notes.join('; ')}.`;
  }
  return out;
}

function isObj(v: unknown): v is Json {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Every key anywhere in a schema tree that strict mode rejects — the contract test asserts this is empty. */
export function findUnsupportedKeywords(node: unknown, path = '$'): string[] {
  if (!isObj(node)) return Array.isArray(node) ? node.flatMap((v, i) => findUnsupportedKeywords(v, `${path}[${i}]`)) : [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) found.push(`${path}.${key}`);
    if (key === 'minItems' && typeof value === 'number' && value > 1) found.push(`${path}.minItems`);
    if (key === 'format' && typeof value === 'string' && !(SUPPORTED_STRING_FORMATS as readonly string[]).includes(value)) found.push(`${path}.format`);
    if (key === 'additionalProperties' && value !== false) found.push(`${path}.additionalProperties`);
    if (key === 'properties' && isObj(value)) {
      for (const [k, v] of Object.entries(value)) found.push(...findUnsupportedKeywords(v, `${path}.properties.${k}`));
    } else if (isObj(value) || Array.isArray(value)) {
      if (key !== 'enum' && key !== 'required' && key !== 'const' && key !== 'default') found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
    }
  }
  if (node.type === 'object' || isObj(node.properties)) {
    if (node.additionalProperties !== false) found.push(`${path}.additionalProperties(missing)`);
    const keys = Object.keys((node.properties as Json | undefined) ?? {});
    const req = Array.isArray(node.required) ? (node.required as string[]) : [];
    for (const k of keys) if (!req.includes(k)) found.push(`${path}.required(${k})`);
  }
  return found;
}

/** Response side: keep the first `max` items of an array, warning once — an over-long list is trimmed, not failed. */
export function trimArray(value: unknown, max: number, label: string): unknown {
  if (Array.isArray(value) && value.length > max) {
    console.warn(`[anthropic] trimmed ${value.length} ${label} to ${max}`);
    return value.slice(0, max);
  }
  return value;
}
