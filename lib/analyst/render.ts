/**
 * THE formatter (design review 2026-10-03, A): every number the owner reads is rendered here, from a
 * ledger entry — the engine's value, its unit, its currency — never by the model. One place decides
 * rounding, thousands separators, the currency code and whether a ratio reads as % or ×, so a displayed
 * number equals the engine's by construction.
 *
 * Values are rendered SIGN-FREE: a delta of −12 % reads "12%" and the sentence says "down" — the direction
 * check (`direction.ts`) holds the words to the sign.
 */

import type { LedgerEntry } from './ledger';

/** A reading hint from a ref token: `{ref|%}` share, `{ref|x}` multiple, `{ref|k}` compact money. */
export type RenderHint = '%' | 'x' | 'k' | null;

export function renderRef(entry: LedgerEntry, hint: RenderHint = null): string {
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

import type { Ledger } from './ledger';
import type { Answer } from './schema';
import type { Flag } from './verify';
import { refTokens } from './verify';

export const NO_SOURCE = '[no source]';

/**
 * Replace every ref token in `text` with its rendered value. After the one repair, an unresolved token
 * reads `[no source]`, a raw digit run the verifier flagged is wrapped `[unverified: 8]`, and a sentence
 * with a direction mismatch is prefixed `[check direction]` — marked, never silent.
 */
export function renderText(text: string, ledger: Ledger, flags: Flag[] = []): string {
  // A direction flag names the sentence in its token form: mark it before the tokens are rendered.
  let marked = text;
  for (const f of flags) if (f.kind === 'direction' && marked.includes(f.text)) marked = marked.replace(f.text, `[check direction] ${f.text}`);
  let out = '';
  let last = 0;
  for (const t of refTokens(marked)) {
    out += marked.slice(last, t.index);
    const entry = ledger.get(t.ref);
    out += entry && entry.value !== null ? renderRef(entry, t.hint) : NO_SOURCE;
    last = t.index + t.text.length;
  }
  out += marked.slice(last);
  for (const f of flags) if (f.kind === 'digits') out = out.replace(f.text, `[unverified: ${f.text}]`);
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
