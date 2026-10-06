/**
 * Direction check (design review 2026-10-03, E) — PURE. In a sentence that cites a DELTA (a ledger entry
 * with `delta: true`: a comparison's pct / abs, a percent_change / difference calculate row), the words
 * must agree with the number:
 *
 *   - SIGN words describe the number's sign: fell / down / decreased / dropped / lower / shrank /
 *     declined need a negative value; rose / up / increased / grew / higher / climbed a positive one.
 *   - JUDGMENT words describe the metric's polarity from the glossary (lowerIsBetter): improved /
 *     better / stronger / healthier vs worsened / worse / weaker / deteriorated. "Paid CAC improved" with a
 *     negative delta is right; with a positive one it is the mismatch; "Enrollments improved" needs a
 *     positive delta. A delta with no known metric (a calculate row over two different things) is not
 *     judged — the reason says so only when a judgment word sits next to it.
 *
 * Neutral wording ("changed by", "moved", "is") never flags. A sentence with several deltas is checked
 * per token against the NEAREST direction word (by character distance). Rendered values are sign-free, so
 * the words are the only place the sign shows — which is why they are checked.
 */

import type { Ledger, LedgerEntry } from './ledger';
import { glossaryEntry, GLOSSARY } from '../metrics/glossary';
import { refTokens } from './refToken';

const SIGN_DOWN = ['fell', 'fall', 'falls', 'falling', 'down', 'decreased', 'decrease', 'decreases', 'decreasing', 'dropped', 'drop', 'drops', 'dropping', 'lower', 'shrank', 'shrunk', 'shrinking', 'declined', 'decline', 'declines', 'declining', 'slipped', 'reduced'];
const SIGN_UP = ['rose', 'rise', 'rises', 'rising', 'up', 'increased', 'increase', 'increases', 'increasing', 'grew', 'grow', 'grows', 'growing', 'higher', 'climbed', 'climb', 'climbs', 'climbing', 'jumped', 'gained'];
const JUDGE_GOOD = ['improved', 'improve', 'improves', 'improving', 'improvement', 'better', 'stronger', 'healthier'];
const JUDGE_BAD = ['worsened', 'worsen', 'worsens', 'worsening', 'worse', 'weaker', 'deteriorated', 'deteriorating'];

type Word = { word: string; index: number; sense: 'down' | 'up' | 'good' | 'bad' };

const WORD_RE = new RegExp(`\\b(${[...SIGN_DOWN, ...SIGN_UP, ...JUDGE_GOOD, ...JUDGE_BAD].join('|')})\\b`, 'gi');

function directionWords(sentence: string): Word[] {
  const out: Word[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WORD_RE.source, 'gi');
  while ((m = re.exec(sentence)) !== null) {
    const w = m[1].toLowerCase();
    out.push({ word: m[1], index: m.index, sense: SIGN_DOWN.includes(w) ? 'down' : SIGN_UP.includes(w) ? 'up' : JUDGE_GOOD.includes(w) ? 'good' : 'bad' });
  }
  return out;
}

/** Sentences of a markdown text (a line break ends one too). */
export function sentences(text: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  // A period ends a sentence only before whitespace or the end — the dots inside a ref token ({r1:data.kpis.x}) do not.
  const re = /(?:[^.!?\n]|\.(?!\s|$))+(?:\.(?=\s|$)|[!?]|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[0].trim()) out.push({ text: m[0], index: m.index });
  return out;
}

/** The glossary's polarity for a metric key named by a tool result (kpis key or glossary key); null when unknown. */
export function lowerIsBetter(metric: string | null): boolean | null {
  if (!metric) return null;
  const direct = glossaryEntry(metric);
  if (direct) return direct.lowerIsBetter;
  // Tool results name kpis in camelCase (paidCacCents, consultsBooked); the glossary in snake_case (paid_cac, consults_booked).
  const snake = metric.replace(/Cents$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const byKey = glossaryEntry(snake) ?? GLOSSARY.find((g) => g.key.replace(/_/g, '') === snake.replace(/_/g, ''));
  return byKey ? byKey.lowerIsBetter : null;
}

export interface DirectionProblem {
  sentence: string;
  /** Offset of the (trimmed) sentence in the text it was found in — the renderer marks it by position. */
  index: number;
  token: string;
  word: string;
  reason: string;
}

export function checkDirection(text: string, ledger: Ledger): DirectionProblem[] {
  const out: DirectionProblem[] = [];
  for (const s of sentences(text)) {
    const words = directionWords(s.text);
    if (words.length === 0) continue;
    const index = s.index + (s.text.length - s.text.trimStart().length);
    for (const t of refTokens(s.text)) {
      const entry: LedgerEntry | undefined = ledger.get(t.ref);
      if (!entry || !entry.delta || entry.value === null || entry.value === 0) continue;
      const nearest = words.reduce((a, b) => (Math.abs(b.index - t.index) < Math.abs(a.index - t.index) ? b : a));
      const positive = entry.value > 0;
      const shown = `${positive ? '+' : '−'}${Math.abs(entry.unit === 'ratio' ? Math.round(entry.value * 1000) / 10 : entry.value)}${entry.unit === 'ratio' ? '%' : ''}`;
      if (nearest.sense === 'down' || nearest.sense === 'up') {
        const wants = nearest.sense === 'up';
        if (wants !== positive) out.push({ sentence: s.text.trim(), index, token: t.text, word: nearest.word, reason: `direction: "${nearest.word}" next to ${t.text} which is ${shown}` });
      } else {
        const lib = lowerIsBetter(entry.metric);
        if (lib === null) {
          out.push({ sentence: s.text.trim(), index, token: t.text, word: nearest.word, reason: `"${nearest.word}" judges ${t.text} (${shown}) but that change belongs to no single metric — use a sign word (up / down) or cite the metric's own delta` });
          continue;
        }
        const good = lib ? !positive : positive;
        const wantsGood = nearest.sense === 'good';
        if (wantsGood !== good) out.push({ sentence: s.text.trim(), index, token: t.text, word: nearest.word, reason: `"${nearest.word}" next to ${t.text} which is ${shown} — ${entry.metric} is ${lib ? 'lower' : 'higher'}-is-better` });
      }
    }
  }
  return out;
}
