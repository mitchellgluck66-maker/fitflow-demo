/**
 * The first section of an answer, read from the PARTIAL JSON the stream has delivered so far (Oct 7 item 6) —
 * PURE. The answer streams as the JSON text of `output_config.format` (or the `submit_answer` tool's
 * `input_json_delta`); the owner will see sections as they complete (Wave 2), so the loop verifies the first
 * complete section the moment its closing brace arrives and records the time — "time to first verified section".
 *
 * A string-aware scanner: after `"sections"` and its `[`, the first `{ … }` balanced outside strings (escapes
 * honoured) is parsed; it counts when it carries a string `key` and a string `body_md`.
 */

export interface PartialSection {
  key: string;
  body_md: string;
}

export function firstSection(partial: string): PartialSection | null {
  const at = partial.indexOf('"sections"');
  if (at < 0) return null;
  const open = partial.indexOf('[', at);
  if (open < 0) return null;
  let i = open + 1;
  // Skip whitespace to the first object.
  while (i < partial.length && /\s/.test(partial[i])) i += 1;
  if (partial[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let j = i; j < partial.length; j++) {
    const ch = partial[j];
    if (inString) {
      if (ch === '\\') j += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const o = JSON.parse(partial.slice(i, j + 1)) as Record<string, unknown>;
          return typeof o.key === 'string' && typeof o.body_md === 'string' ? { key: o.key, body_md: o.body_md } : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
