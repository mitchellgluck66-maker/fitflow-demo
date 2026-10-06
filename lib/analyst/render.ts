/**
 * THE formatter (design review 2026-10-03, A): every number the owner reads is rendered here, from a
 * ledger entry — the engine's value, its unit, its currency — never by the model. One place decides
 * rounding, thousands separators, the currency code and whether a ratio reads as % or ×, so a displayed
 * number equals the engine's by construction.
 *
 * Values are rendered SIGN-FREE: a delta of −12 % reads "12%" and the sentence says "down" — the direction
 * check (`direction.ts`) holds the words to the sign.
 */

import type { Ledger, LedgerEntry } from './ledger';
import { refTokens } from './refToken';
import type { Flag } from './verify';

/** A reading hint from a ref token: `{ref|%}` share, `{ref|x}` multiple, `{ref|k}` compact money. */
export type RenderHint = '%' | 'x' | 'k' | null;

export function renderRef(entry: LedgerEntry, hint: RenderHint = null): string {
  if (entry.unit === 'text') return entry.text ?? '—';
  if (entry.value === null) return '—';
  const abs = Math.abs(entry.value);
  switch (entry.unit) {
    case 'cents': {
      const dollars = abs / 100;
      if (hint === 'k' && dollars >= 10_000) return `$${(dollars / 1000).toFixed(1)}k ${entry.currency}`;
      const whole = Number.isInteger(dollars);
      return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} ${entry.currency}`;
    }
    case 'ratio': {
      const multiple = hint === 'x' || (hint !== '%' && entry.reading === 'multiple');
      if (multiple) return `${(Math.round(abs * 10) / 10).toFixed(1)}×`;
      const pct = Math.round(abs * 1000) / 10;
      return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
    }
    case 'count':
      return Math.round(abs).toLocaleString('en-US');
    case 'hours':
      return `${Math.round(abs * 10) / 10} h`;
    default:
      return String(Math.round(abs * 100) / 100);
  }
}

// ---------------------------------------------------------------------------
// Whole answers
// ---------------------------------------------------------------------------

import type { Answer } from './schema';

export const NO_SOURCE = '[no source]';

/** A token's place in the rendered text: `[start, end)` in rendered coordinates, and the token it came from. */
export interface RenderedSpan {
  start: number;
  end: number;
  /** The token's offset and length in the token-form text. */
  tokenIndex: number;
  tokenLength: number;
  ref: string;
  resolved: boolean;
}

/** Render every token; return the rendered text and where each token landed in it. */
export function renderWithSpans(text: string, ledger: Ledger): { text: string; spans: RenderedSpan[] } {
  let out = '';
  let last = 0;
  const spans: RenderedSpan[] = [];
  for (const t of refTokens(text)) {
    out += text.slice(last, t.index);
    const entry = ledger.get(t.ref);
    const resolved = Boolean(entry && (entry.unit === 'text' ? entry.text !== undefined : entry.value !== null));
    const value = resolved ? renderRef(entry as LedgerEntry, t.hint) : NO_SOURCE;
    spans.push({ start: out.length, end: out.length + value.length, tokenIndex: t.index, tokenLength: t.text.length, ref: t.ref, resolved });
    out += value;
    last = t.index + t.text.length;
  }
  out += text.slice(last);
  return { text: out, spans };
}

/** The rendered offset of an offset in the token-form text (a position inside a token maps to the token's start). */
export function toRenderedIndex(spans: RenderedSpan[], index: number): number {
  let shift = 0;
  for (const sp of spans) {
    if (sp.tokenIndex + sp.tokenLength <= index) shift += sp.end - sp.start - sp.tokenLength;
    else if (sp.tokenIndex < index) return sp.start;
    else break;
  }
  return index + shift;
}

/**
 * Replace every ref token in `text` with its rendered value. After the one repair, an unresolved token
 * reads `[no source]`, a raw digit run the verifier flagged is wrapped `[unverified: 8]`, and a sentence
 * with a direction mismatch is prefixed `[check direction]` — marked, never silent.
 *
 * Marks are applied BY POSITION (item 3, 2026-10-06): a digits flag carries its offset in the rendered text,
 * a direction flag its sentence's offset in the token-form text (mapped through the spans). Nothing is
 * located by searching for the text, so a flagged bare "2" can never mark the "2" inside "$2,153.45".
 * A flag without a position (one stored before this rule) falls back to its first occurrence outside a span.
 */
export function renderText(text: string, ledger: Ledger, flags: Flag[] = []): string {
  const { text: rendered, spans } = renderWithSpans(text, ledger);
  type Edit = { at: number; order: number; apply: (s: string) => string };
  const edits: Edit[] = [];
  const firstOutsideSpans = (needle: string): number => {
    let from = 0;
    for (;;) {
      const i = rendered.indexOf(needle, from);
      if (i < 0) return -1;
      if (!spans.some((sp) => i < sp.end && i + needle.length > sp.start)) return i;
      from = i + 1;
    }
  };
  for (const f of flags) {
    if (f.kind === 'digits') {
      const at = f.index ?? firstOutsideSpans(f.text);
      if (at < 0) continue;
      const len = f.length ?? f.text.length;
      edits.push({ at, order: 0, apply: (s) => `${s.slice(0, at)}[unverified: ${s.slice(at, at + len)}]${s.slice(at + len)}` });
    } else if (f.kind === 'direction') {
      const at = f.index !== undefined ? toRenderedIndex(spans, f.index) : (() => { const i = text.indexOf(f.text); return i < 0 ? -1 : toRenderedIndex(spans, i); })();
      if (at < 0) continue;
      edits.push({ at, order: 1, apply: (s) => `${s.slice(0, at)}[check direction] ${s.slice(at)}` });
    }
  }
  // Right to left, so an edit never moves the offsets of the ones still to apply; at the same offset the wrap
  // goes first so the direction prefix lands before it.
  edits.sort((a, b) => b.at - a.at || a.order - b.order);
  let out = rendered;
  for (const e of edits) out = e.apply(out);
  return out;
}

export interface RenderedAnswer {
  kind: Answer['kind'];
  headline: string;
  sections: Array<{ key: Answer['sections'][number]['key']; body_md: string }>;
  actions: Array<Omit<Answer['actions'][number], 'expected_impact'> & { expected_impact: string }>;
  findings: Array<Omit<Answer['findings'][number], 'finding'> & { finding: string }>;
  note_proposals: string[];
  clarifying_question: string;
}

/** The answer as the owner reads it: every token rendered from the ledger; flags for this field applied. */
export function renderAnswer(answer: Answer, ledger: Ledger, flagged: Flag[] = []): RenderedAnswer {
  const flagsFor = (section: string) => flagged.filter((f) => f.section === section);
  return {
    kind: answer.kind,
    headline: renderText(answer.headline.text, ledger, flagsFor('headline')),
    sections: answer.sections.map((s) => ({ key: s.key, body_md: renderText(s.body_md, ledger, flagsFor(s.key)) })),
    actions: answer.actions.map((a, i) => ({ ...a, action: renderText(a.action, ledger, flagsFor(`actions[${i}].action`)), why: renderText(a.why, ledger, flagsFor(`actions[${i}].why`)), expected_impact: renderText(a.expected_impact, ledger, flagsFor(`actions[${i}].expected_impact`)) })),
    findings: answer.findings.map((f, i) => ({ ...f, finding: renderText(f.finding, ledger, flagsFor(`findings[${i}]`)) })),
    note_proposals: answer.note_proposals,
    clarifying_question: answer.clarifying_question,
  };
}
