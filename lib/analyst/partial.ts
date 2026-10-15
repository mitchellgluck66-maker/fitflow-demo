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
  return completedSections(partial)[0] ?? null;
}

/**
 * Every section object that has CLOSED so far, in order (Wave 2 tune-up 3: the panel shows each section the moment it
 * verifies, not only the first). Stops at the first object that is still open, malformed, or not a section.
 */
export function completedSections(partial: string): PartialSection[] {
  const out: PartialSection[] = [];
  const at = partial.indexOf('"sections"');
  if (at < 0) return out;
  const open = partial.indexOf('[', at);
  if (open < 0) return out;
  let i = open + 1;
  for (;;) {
    // Skip whitespace and the comma between objects to the next object.
    while (i < partial.length && /[\s,]/.test(partial[i])) i += 1;
    if (partial[i] !== '{') return out;
    let depth = 0;
    let inString = false;
    let closed = -1;
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
          closed = j;
          break;
        }
      }
    }
    if (closed < 0) return out;
    try {
      const o = JSON.parse(partial.slice(i, closed + 1)) as Record<string, unknown>;
      if (typeof o.key !== 'string' || typeof o.body_md !== 'string') return out;
      out.push({ key: o.key, body_md: o.body_md });
    } catch {
      return out;
    }
    i = closed + 1;
  }
}
