/**
 * Ref tokens — the one place the token grammar lives. `{r2:data.kpis.paidCacCents.current}` or
 * `{r7:data.results[1].value|%}` (hints `%` share, `x` multiple, `k` compact money). The verifier, the
 * direction check and the renderer all read tokens through `refTokens`, so a token found by one is a token
 * for all of them.
 */

/** `{<ref>}` or `{<ref>|hint}` — the ref exactly as a tool result gives it. */
export const TOKEN = /\{(r\d+:data\.[^{}|\s]+)(?:\|(%|x|k))?\}/g;

export interface RefToken {
  text: string;
  ref: string;
  hint: '%' | 'x' | 'k' | null;
  /** Offset of the token in the text it was found in. */
  index: number;
}

export function refTokens(text: string): RefToken[] {
  const out: RefToken[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], ref: m[1], hint: (m[2] as RefToken['hint']) ?? null, index: m.index });
  return out;
}

/** The text with every token replaced by a word, so a scan of the prose sees no token internals. */
export function withoutTokens(text: string): string {
  return text.replace(new RegExp(TOKEN.source, 'g'), 'REF');
}
