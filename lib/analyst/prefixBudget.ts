/**
 * The cold prefix budget (Oct 7 item 5, 2026-10-07). A cold turn pays the whole prefix — contract + brief +
 * tools + the first user message (the starter snapshot) — at the 1-hour cache-write rate ($8/MTok on Opus):
 * 52K tokens ≈ $0.42 before a word is generated. So the prefix is measured per piece on every smoke run (four
 * free `count_tokens` calls, differenced) and a build-time test holds the demo tenant's prefix under
 * `PREFIX_BUDGET_TOKENS` by the chars ÷ 3.6 approximation, so growth fails `npm run check` before a smoke.
 */

import type { BetaMessageParam, BetaTool } from './api';
import { buildCountRequest } from './api';
import type { AnalystModel } from './config';

export const PREFIX_BUDGET_TOKENS = 40_000;
/**
 * Characters per token the approximation assumes. 2026-10-15, measured with count_tokens on the demo tenant: contract
 * 2.9 · brief 2.3 (tables of numbers and pipes) · tools 2.4 (JSON) · snapshot 2.2 — the earlier 3.6 (prose) under-counted
 * the prefix by ~40 %, which is how a 34.7K measured prefix passed a 40K budget test at "≈ 23K".
 */
export const CHARS_PER_TOKEN = 2.4;

export interface PrefixPieces {
  contract: number;
  brief: number;
  tools: number;
  /** The first user message: the starter snapshot (two tool results + their indexes) and the question. */
  snapshot: number;
  total: number;
  measured: boolean;
}

export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface PrefixParts {
  contract: string;
  brief: string;
  tools: readonly BetaTool[];
  messages: readonly BetaMessageParam[];
}

/** The approximation (pure). */
export function approxPrefix(p: PrefixParts): PrefixPieces {
  const contract = approxTokens(p.contract);
  const brief = approxTokens(p.brief);
  const tools = approxTokens(JSON.stringify(p.tools));
  const snapshot = approxTokens(JSON.stringify(p.messages));
  return { contract, brief, tools, snapshot, total: contract + brief + tools + snapshot, measured: false };
}

/** Four free counts, differenced: contract alone → + brief → + tools → + the message(s). */
export async function measurePrefix(model: AnalystModel, p: PrefixParts, count: (params: ReturnType<typeof buildCountRequest>) => Promise<number>): Promise<PrefixPieces> {
  const probe: BetaMessageParam[] = [{ role: 'user', content: 'x' }];
  const a = await count(buildCountRequest({ model, system: [p.contract, ''], tools: [], messages: probe }));
  const b = await count(buildCountRequest({ model, system: [p.contract, p.brief], tools: [], messages: probe }));
  const c = await count(buildCountRequest({ model, system: [p.contract, p.brief], tools: [...p.tools], messages: probe }));
  const d = await count(buildCountRequest({ model, system: [p.contract, p.brief], tools: [...p.tools], messages: [...p.messages] }));
  const contract = a;
  const brief = Math.max(0, b - a);
  const tools = Math.max(0, c - b);
  const snapshot = Math.max(0, d - c);
  return { contract, brief, tools, snapshot, total: d, measured: true };
}

const k = (n: number) => `${(n / 1000).toFixed(1)}K`;

/** "prefix: contract 2.7K · brief 6.1K · tools 5.1K · snapshot 4.9K · total 18.8K (count_tokens) — budget 40.0K" */
export function formatPrefixLine(p: PrefixPieces): string {
  const over = p.total > PREFIX_BUDGET_TOKENS ? ` — OVER the ${k(PREFIX_BUDGET_TOKENS)} budget` : ` — budget ${k(PREFIX_BUDGET_TOKENS)}`;
  return `prefix: contract ${k(p.contract)} · brief ${k(p.brief)} · tools ${k(p.tools)} · snapshot ${k(p.snapshot)} · total ${k(p.total)} (${p.measured ? 'count_tokens' : `≈ chars ÷ ${CHARS_PER_TOKEN}`})${over}`;
}

/** The piece most over its share when the total is over budget — named so the fix is obvious. Null when within budget. */
export function overBudget(p: PrefixPieces): string | null {
  if (p.total <= PREFIX_BUDGET_TOKENS) return null;
  const pieces: Array<[string, number]> = [['brief', p.brief], ['snapshot', p.snapshot], ['tools', p.tools], ['contract', p.contract]];
  pieces.sort((x, y) => y[1] - x[1]);
  return `prefix ${k(p.total)} tokens > ${k(PREFIX_BUDGET_TOKENS)} budget — largest piece: ${pieces[0][0]} ${k(pieces[0][1])}`;
}
