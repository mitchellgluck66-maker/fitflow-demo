/**
 * Verifier v2 (design review 2026-10-03, A) — PURE. The model never writes a metric's value: prose carries
 * REF TOKENS — `{r2:data.marketing.paidCacCents}`, `{r7:data.results[1].value|%}` — and the server
 * renders them (render.ts). So the checks are:
 *
 *   1. every token resolves: a known ref, not withheld (null), not older than the newest sync marker;
 *   2. no raw digit run in prose outside a token, except the exempt contexts (ISO dates, times,
 *      month-day, years, durations, ordinals, markdown list numbers, refs) and a digit string the owner
 *      wrote verbatim in THIS question;
 *   3. findings' evidence refs exist;
 *   4. direction words agree with the sign / polarity of the delta they sit next to (direction.ts).
 *
 * ONE repair turn with the exact problems; after that the renderer shows `[no source]` for an unresolved
 * token and `[unverified: 8]` around a raw digit — marked, never silent. The old verifier compared the
 * model's rendering with a table of acceptable roundings; with one renderer there is nothing to compare.
 */

import type { Ledger } from './ledger';
import type { Answer } from './schema';
import { checkDirection } from './direction';

export type FlagKind = 'ref' | 'digits' | 'evidence' | 'direction';

export interface Flag {
  kind: FlagKind;
  section: string;
  /** The token or digit run (or the sentence, for a direction flag) as it appears in the text. */
  text: string;
  reason: string;
}

export interface Verification {
  ok: boolean;
  flagged: Flag[];
  /** Tokens that resolved. */
  verified: number;
}

/** `{<ref>}` or `{<ref>|hint}` — the ref exactly as a tool result gives it. */
export const TOKEN = /\{(r\d+:data\.[^{}|\s]+)(?:\|(%|x|k))?\}/g;

export interface RefToken {
  text: string;
  ref: string;
  hint: '%' | 'x' | 'k' | null;
  index: number;
}

export function refTokens(text: string): RefToken[] {
  const out: RefToken[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], ref: m[1], hint: (m[2] as RefToken['hint']) ?? null, index: m.index });
  return out;
}

/** The text with every token replaced by a word, so the digit scan and the exempt contexts see prose only. */
export function withoutTokens(text: string): string {
  return text.replace(new RegExp(TOKEN.source, 'g'), 'REF');
}

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;
const DURATION_AFTER = /^\s?(-|\s)?(day|days|week|weeks|wk|wks|month|months|mo|year|years|yr|hour|hours|h|hr|hrs|min|mins|minute|minutes|s|sec|seconds|st|nd|rd|th)\b/i;
const ORDINAL_BEFORE = /(#|no\.?|number|day[- ]|week[- ]|step|round|section|page|q|top|bottom|first|last)\s?$/i;

/** Every digit run in prose: "1,605", "8", "41.2", "2026-09-30". */
const NUMBER_TOKEN = /(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k\b|K\b|%|×|x\b)?(\s?(CAD|USD))?/g;

export interface Token {
  text: string;
  index: number;
  value: number;
  suffix: '' | 'k' | '%' | 'x';
  money: boolean;
}

function parseToken(m: RegExpExecArray): Token {
  const raw = m[0];
  const money = Boolean(m[1]) || Boolean(m[5]);
  const num = Number(`${m[2].replace(/,/g, '')}${m[3] ?? ''}`);
  const s = (m[4] ?? '').trim();
  const suffix: Token['suffix'] = s === '%' ? '%' : s === '×' || s === 'x' ? 'x' : s.toLowerCase() === 'k' ? 'k' : '';
  return { text: raw.trim(), index: m.index, value: num, suffix, money };
}

/** Is this digit run part of a date, a time, a duration, an ordinal, a list number or a ref — not a metric? */
export function isExemptContext(body: string, t: Token): boolean {
  const before = body.slice(Math.max(0, t.index - 24), t.index);
  const after = body.slice(t.index + t.text.length, t.index + t.text.length + 16);
  const whole = body.slice(Math.max(0, t.index - 12), t.index + t.text.length + 12);
  if (t.suffix === '%' || t.suffix === 'k' || t.suffix === 'x' || t.money) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(whole)) return true; // ISO date
  if (/\d{1,2}:\d{2}/.test(whole)) return true; // time
  if (MONTHS.test(before)) return true; // "Sep 3", "Aug 2–8"
  if (/[–-]\s?$/.test(before) && MONTHS.test(body.slice(Math.max(0, t.index - 24), t.index).replace(/\d{1,2}\s?[–-]\s?$/, ''))) return true; // "Sep 20–26"
  if (/^\s?[–-]\s?\d/.test(after) && MONTHS.test(before.replace(/\s$/, ''))) return true;
  if (t.value >= 1990 && t.value <= 2100 && Number.isInteger(t.value) && !/[,.]/.test(t.text)) return true; // a year
  if (DURATION_AFTER.test(after)) return true;
  if (ORDINAL_BEFORE.test(before)) return true;
  if (/(^|\n)\s*$/.test(before) && /^\./.test(after)) return true; // markdown list "1."
  if (/\br$/.test(before) || /^:data/.test(after)) return true; // a ref like r3:data.x
  if (/\[\s?$/.test(before) && /^\s?\]/.test(after)) return true; // a JSON path index
  return false;
}

export function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = new RegExp(NUMBER_TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim() === '') {
      re.lastIndex += 1;
      continue;
    }
    out.push(parseToken(m));
  }
  return out;
}

export interface VerifyOptions {
  /** ISO: a ref fetched before this is stale (the newest sync marker since the turn began). */
  staleBefore?: string | null;
  /** The owner's question this turn: a digit string written there may be repeated verbatim. */
  question?: string | null;
}

/** Every text field of an answer, with the section it is reported under. */
export function answerTexts(answer: Answer): Array<{ section: string; text: string }> {
  return [
    { section: 'headline', text: answer.headline.text },
    ...answer.sections.map((s) => ({ section: s.key, text: s.body_md })),
    ...answer.actions.flatMap((a, i) => [
      { section: `actions[${i}].action`, text: a.action },
      { section: `actions[${i}].why`, text: a.why },
      { section: `actions[${i}].expected_impact`, text: a.expected_impact },
    ]),
    ...answer.findings.map((f, i) => ({ section: `findings[${i}]`, text: f.finding })),
  ];
}

export function verifyAnswer(answer: Answer, ledger: Ledger, opts: VerifyOptions = {}): Verification {
  const flagged: Flag[] = [];
  let verified = 0;
  const questionDigits = new Set(tokens(opts.question ?? '').map((t) => t.text.replace(/\s/g, '')));

  for (const { section, text } of answerTexts(answer)) {
    // 1. Tokens resolve.
    for (const t of refTokens(text)) {
      const entry = ledger.get(t.ref);
      if (!entry) flagged.push({ kind: 'ref', section, text: t.text, reason: `no such ref "${t.ref}" — cite a number from a tool result in this conversation` });
      else if (entry.value === null) flagged.push({ kind: 'ref', section, text: t.text, reason: `ref "${t.ref}" is withheld (null) — this number has no source; say why it is withheld instead` });
      else if (opts.staleBefore && entry.fetchedAt < opts.staleBefore) flagged.push({ kind: 'ref', section, text: t.text, reason: `ref "${t.ref}" predates the latest sync — re-fetch` });
      else verified += 1;
    }
    // 2. No raw digits outside a token.
    const prose = withoutTokens(text);
    for (const t of tokens(prose)) {
      if (isExemptContext(prose, t)) continue;
      if (questionDigits.has(t.text.replace(/\s/g, ''))) continue;
      flagged.push({ kind: 'digits', section, text: t.text, reason: `"${t.text}" is a number written as digits — write its ref in braces instead ({r2:data.<path>}); only dates, durations, ordinals and the owner's own figures may be digits` });
    }
    // 4. Direction words agree with the delta they sit next to.
    for (const d of checkDirection(text, ledger)) flagged.push({ kind: 'direction', section, text: d.sentence, reason: d.reason });
  }
  // 3. Evidence refs exist.
  for (const f of answer.findings) for (const ref of f.evidence_refs) if (!ledger.get(ref)) flagged.push({ kind: 'evidence', section: 'findings', text: f.finding, reason: `no such evidence ref "${ref}"` });

  return { ok: flagged.length === 0, flagged, verified };
}

/** The repair message appended (hidden) when an answer fails verification or structure. */
export function repairMessage(problems: string[]): string {
  return `Your answer was not accepted. Fix ONLY these problems and answer again in the same structure:\n${problems.map((p) => `- ${p}`).join('\n')}\nRules: a metric is never written as digits — write its ref in braces ({r2:data.kpis.enrollments.current}, {r7:data.results[0].value|%}) and the server prints the number; a ref must come from a tool result in this conversation; direction words must match the sign of the change they describe. If a number has no source, remove it or fetch it with a tool.`;
}
