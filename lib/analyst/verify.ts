/**
 * Rule 3 of the runtime (plan item 6) — PURE: a number is shown only with a
 * ref. Every number in a section's prose must be one of the section's declared
 * `numbers`, and each declared number must equal the referenced tool-result
 * value under that unit's rendering (count exact; cents as whole dollars, two
 * decimals or one-decimal k; ratio as a percent or a multiple). Small integers
 * pass without a ref only in a date, duration or ordinal context. A ref whose
 * tool result predates the newest sync marker is rejected with "re-fetch".
 *
 * The old Ask verifier (lib/metrics/ask.ts#verifyAnswerNumbers) accepted any
 * number within 1% of ANY context value; against a large ledger that would
 * pass almost anything, which is why refs are required here.
 */

import type { Ledger, LedgerEntry } from './ledger';
import type { Answer } from './schema';

export interface Flag {
  section: string;
  text: string;
  reason: string;
}

export interface Verification {
  ok: boolean;
  flagged: Flag[];
  /** Declared numbers that verified. */
  verified: number;
}

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;
const DURATION_AFTER = /^\s?(-|\s)?(day|days|week|weeks|wk|wks|month|months|mo|year|years|yr|hour|hours|h|hr|hrs|min|mins|minute|minutes|s|sec|seconds|st|nd|rd|th|x|×)\b/i;
const ORDINAL_BEFORE = /(#|no\.?|number|day[- ]|week[- ]|step|round|section|page|q|top|bottom|first|last)\s?$/i;

/** Every numeric token in prose: "$1,605.33 CAD", "$1.6k", "41%", "2.5×", "8", "1,234". */
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

/** Is this token part of a date, a time, a duration, an ordinal, a list number or a ref — not a metric? */
export function isExemptContext(body: string, t: Token): boolean {
  const before = body.slice(Math.max(0, t.index - 24), t.index);
  const after = body.slice(t.index + t.text.length, t.index + t.text.length + 16);
  const whole = body.slice(Math.max(0, t.index - 12), t.index + t.text.length + 12);
  if (t.suffix === '%' || t.suffix === 'k' || t.money) return false;
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

function norm(s: string): string {
  return s.replace(/\s+/g, '').replace(/CAD|USD/gi, '').toLowerCase();
}

/** Does `text` render `entry` under its unit? */
export function renders(entry: LedgerEntry, text: string): boolean {
  if (entry.value === null) return false;
  const m = new RegExp(NUMBER_TOKEN.source).exec(text.trim());
  if (!m || m.index !== 0) return false;
  const t = parseToken(m as RegExpExecArray);
  const v = entry.value;
  const close = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  switch (entry.unit) {
    case 'cents': {
      const dollars = v / 100;
      if (t.suffix === 'k') return close(r1(dollars / 1000), t.value, 1e-9) || close(r2(dollars / 1000), t.value, 1e-9);
      if (t.suffix === '%' || t.suffix === 'x') return false;
      if (/\.\d{1,2}$/.test(t.text.replace(/\s?(CAD|USD)$/, ''))) return close(dollars, t.value, 0.005 + 1e-9) || close(r1(dollars), t.value, 1e-9);
      return Math.round(dollars) === t.value;
    }
    case 'ratio': {
      if (t.suffix === '%') return close(Math.round(v * 100), t.value, 1e-9) || close(r1(v * 100), t.value, 1e-9);
      if (t.suffix === 'x') return close(r1(v), t.value, 1e-9) || close(r2(v), t.value, 1e-9);
      if (t.suffix === 'k' || t.money) return false;
      return close(v, t.value, 0.0005) || close(r2(v), t.value, 1e-9);
    }
    case 'count': {
      if (t.suffix === 'k') return close(r1(v / 1000), t.value, 1e-9);
      if (t.suffix) return false;
      return v === t.value;
    }
    default: {
      if (t.suffix === '%' || t.suffix === 'k') return false;
      return v === t.value || close(r1(v), t.value, 1e-9) || close(r2(v), t.value, 1e-9);
    }
  }
}

export interface VerifyOptions {
  /** ISO: a ref fetched before this is stale (the newest sync marker since the turn began). */
  staleBefore?: string | null;
}

export function verifyAnswer(answer: Answer, ledger: Ledger, opts: VerifyOptions = {}): Verification {
  const flagged: Flag[] = [];
  let verified = 0;

  const checkDeclared = (section: string, n: { text: string; ref: string }) => {
    const entry = ledger.get(n.ref);
    if (!entry) return flagged.push({ section, text: n.text, reason: `no such ref "${n.ref}" — cite a number from a tool result in this conversation` });
    if (entry.value === null) return flagged.push({ section, text: n.text, reason: `ref "${n.ref}" is withheld (null) — this number has no source` });
    if (opts.staleBefore && entry.fetchedAt < opts.staleBefore) return flagged.push({ section, text: n.text, reason: `ref "${n.ref}" predates the latest sync — re-fetch` });
    if (!renders(entry, n.text)) return flagged.push({ section, text: n.text, reason: `"${n.text}" does not equal ${n.ref} = ${entry.value} (${entry.unit})` });
    verified += 1;
  };

  // The headline: at most one number, and it must be the ref'd one.
  const headTokens = tokens(answer.headline.text).filter((t) => !isExemptContext(answer.headline.text, t));
  if (headTokens.length > 0) {
    if (!answer.headline.ref) flagged.push({ section: 'headline', text: headTokens[0].text, reason: 'the headline has a number but no ref' });
    else for (const t of headTokens) checkDeclared('headline', { text: t.text, ref: answer.headline.ref });
  }

  for (const s of answer.sections) {
    const declared = s.numbers.map((n) => norm(n.text));
    for (const n of s.numbers) checkDeclared(s.key, n);
    for (const t of tokens(s.body_md)) {
      if (isExemptContext(s.body_md, t)) continue;
      const key = norm(t.text);
      const found = declared.some((d) => d === key || d.startsWith(key) || key.startsWith(d));
      if (!found) flagged.push({ section: s.key, text: t.text, reason: 'a number in the prose with no declared ref' });
    }
  }

  for (const a of answer.actions) {
    if (a.expected_impact_ref) {
      const entry = ledger.get(a.expected_impact_ref);
      if (!entry) flagged.push({ section: 'actions', text: a.action, reason: `no such ref "${a.expected_impact_ref}" for the expected impact` });
    }
    for (const t of tokens(a.expected_impact)) {
      if (isExemptContext(a.expected_impact, t)) continue;
      if (!a.expected_impact_ref) flagged.push({ section: 'actions', text: t.text, reason: 'an expected impact with a number needs expected_impact_ref' });
    }
  }

  for (const f of answer.findings) {
    for (const ref of f.evidence_refs) if (!ledger.get(ref)) flagged.push({ section: 'findings', text: f.finding, reason: `no such evidence ref "${ref}"` });
  }

  return { ok: flagged.length === 0, flagged, verified };
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

/** The repair message appended (hidden) when an answer fails verification or structure. */
export function repairMessage(problems: string[]): string {
  return `Your answer was not accepted. Fix ONLY these problems and answer again in the same structure:\n${problems.map((p) => `- ${p}`).join('\n')}\nRules: every number in the prose must be listed in that section's numbers with the ref of the tool result it came from, and must equal that value (money as dollars with its code, ratios as percentages or multiples). If a number has no source, remove it or fetch it with a tool.`;
}
