/**
 * Analyst cost, in USD (amendment 6: every AI cost figure is labelled USD).
 *
 * Prices per million tokens, from the Anthropic pricing page as verified for the
 * plan on 2026-09-30. A response is priced by the model it names, from its
 * `usage` (input, output, cache read, cache creation) plus every
 * `usage.iterations` entry (a compaction request reports its cost there and
 * zero at the top level). Pure.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** 5-minute cache write (the only TTL the Analyst requests). */
  cacheWrite5mPerMTok: number;
  /** 1-hour cache write: 2× input per the pricing page's TTL rule. Never requested by the Analyst. */
  cacheWrite1hPerMTok: number;
}

export const ANALYST_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 5, cacheWrite1hPerMTok: 8 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20 },
};

/** The subset of the API's `usage` object the price depends on (top level or one `iterations` entry). */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  iterations?: Array<UsageLike & { type?: string }> | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`No price table for model "${model}" — add it to ANALYST_PRICES before pricing its usage`);
    this.name = 'UnknownModelPriceError';
  }
}

/** Sum the billable token counts of one usage object, iterations included (a compaction's cost lives only there). */
export function usageTotals(usage: UsageLike): UsageTotals {
  const one = (u: UsageLike): UsageTotals => {
    const creation = u.cache_creation ?? null;
    const w5 = creation?.ephemeral_5m_input_tokens ?? null;
    const w1h = creation?.ephemeral_1h_input_tokens ?? null;
    // Without the TTL breakdown the flat count is a 5-minute write (the only TTL we request).
    const flat = u.cache_creation_input_tokens ?? 0;
    return {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWrite5mTokens: w5 ?? (w1h === null ? flat : Math.max(0, flat - w1h)),
      cacheWrite1hTokens: w1h ?? 0,
    };
  };
  const top = one(usage);
  for (const it of usage.iterations ?? []) {
    const t = one(it);
    top.inputTokens += t.inputTokens;
    top.outputTokens += t.outputTokens;
    top.cacheReadTokens += t.cacheReadTokens;
    top.cacheWrite5mTokens += t.cacheWrite5mTokens;
    top.cacheWrite1hTokens += t.cacheWrite1hTokens;
  }
  return top;
}

/** USD for one response. Throws on a model without a price row: a silent $0 would hide spend from the caps. */
export function priceUsage(model: string, usage: UsageLike): number {
  const p = ANALYST_PRICES[model];
  if (!p) throw new UnknownModelPriceError(model);
  const t = usageTotals(usage);
  const usd =
    (t.inputTokens * p.inputPerMTok +
      t.outputTokens * p.outputPerMTok +
      t.cacheReadTokens * p.cacheReadPerMTok +
      t.cacheWrite5mTokens * p.cacheWrite5mPerMTok +
      t.cacheWrite1hTokens * p.cacheWrite1hPerMTok) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** "$0.21 USD" — 2 decimals, or 4 when the amount is under a cent so a probe line never reads "$0.00". */
export function formatUsd(usd: number): string {
  const digits = usd > 0 && usd < 0.01 ? 4 : 2;
  return `$${usd.toFixed(digits)} USD`;
}

/** "18.2K in (15.9K cached) · 2.4K out" for status lines. */
export function formatTokens(t: UsageTotals): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  const inTotal = t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
  const cached = t.cacheReadTokens > 0 ? ` (${k(t.cacheReadTokens)} cached)` : '';
  return `${k(inTotal)} in${cached} · ${k(t.outputTokens)} out`;
}
