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

/**
 * The cost split of a turn (design review 2026-10-03, D): input · cache read · cache write · thinking · answer.
 * `answerTokens` = the visible output (the answer text and the tool calls), measured with count_tokens when a
 * counter is given, else ≈ chars ÷ 3.5 and labelled so; thinking = the rest of `output_tokens` (derived).
 * The five parts sum to the turn's cost (test).
 */
export interface CostSplit {
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  thinkingUsd: number;
  answerUsd: number;
  answerTokens: number;
  thinkingTokens: number;
  /** true when answerTokens was estimated from characters (no counter). */
  approximate: boolean;
}

export function splitUsage(model: string, t: UsageTotals, answerTokens: number, approximate: boolean): CostSplit {
  const p = ANALYST_PRICES[model];
  if (!p) throw new UnknownModelPriceError(model);
  const answer = Math.min(Math.max(0, Math.round(answerTokens)), t.outputTokens);
  const thinking = t.outputTokens - answer;
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    inputUsd: r6((t.inputTokens * p.inputPerMTok) / 1e6),
    cacheReadUsd: r6((t.cacheReadTokens * p.cacheReadPerMTok) / 1e6),
    cacheWriteUsd: r6((t.cacheWrite5mTokens * p.cacheWrite5mPerMTok + t.cacheWrite1hTokens * p.cacheWrite1hPerMTok) / 1e6),
    thinkingUsd: r6((thinking * p.outputPerMTok) / 1e6),
    answerUsd: r6((answer * p.outputPerMTok) / 1e6),
    answerTokens: answer,
    thinkingTokens: thinking,
    approximate,
  };
}

/** "$0.31 USD = in $0.02 · cache read $0.05 · cache write $0.08 · thinking $0.09 · answer $0.07 (answer 3.1K tok measured · thinking 4.4K derived)" */
export function formatSplit(s: CostSplit): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  const total = s.inputUsd + s.cacheReadUsd + s.cacheWriteUsd + s.thinkingUsd + s.answerUsd;
  return `${formatUsd(total)} = in ${formatUsd(s.inputUsd)} · cache read ${formatUsd(s.cacheReadUsd)} · cache write ${formatUsd(s.cacheWriteUsd)} · thinking ${formatUsd(s.thinkingUsd)} · answer ${formatUsd(s.answerUsd)} (answer ${k(s.answerTokens)} tok ${s.approximate ? '≈ from characters, count unavailable' : 'measured'} · thinking ${k(s.thinkingTokens)} derived)`;
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

// ---------------------------------------------------------------------------
// Estimate before a run, caps, in-loop pause (plan item 7)
// ---------------------------------------------------------------------------

export type RunKind = 'ask' | 'explain' | 'report';

/**
 * Per-kind allowances (item 5, re-derived 2026-09-30 from the first live smoke on Opus 5.5 — turn 1: 19 rounds,
 * 11 tools, 267K input of which 159K cached, $0.82; the old model assumed 4 rounds × 5K uncached tool tokens and
 * 3K output and came out 35–60% low):
 *   - rounds: API requests in the turn (after items 1 and 4: snapshot → gather → calculate → answer);
 *   - toolTokensPerRound: tokens the round's tool results add (several tools per round now; a scorecard is ~3K,
 *     a campaign table ~1.5K, a client list ~2K);
 *   - thinkingPerRound: output tokens of reasoning + tool calls per request — the term the old model had no
 *     line for (turn 1's $0.82 implies ~16K output over 19 rounds ≈ 850 per round; a 4-round turn thinks more
 *     per round);
 *   - answerTokens: the final structured answer.
 * With the moving cache breakpoints (item 2) a round's new tokens are WRITTEN to cache once (1.25× input) and
 * READ afterwards (0.1×), so uncached input no longer compounds with the round count.
 */
export const RUN_ALLOWANCE: Record<RunKind, { rounds: number; toolTokensPerRound: number; thinkingPerRound: number; answerTokens: number }> = {
  ask: { rounds: 4, toolTokensPerRound: 6_000, thinkingPerRound: 1_500, answerTokens: 3_500 },
  explain: { rounds: 3, toolTokensPerRound: 4_000, thinkingPerRound: 1_200, answerTokens: 2_500 },
  report: { rounds: 8, toolTokensPerRound: 8_000, thinkingPerRound: 2_000, answerTokens: 12_000 },
};

export interface RunEstimate {
  usd: number;
  /** "~4 rounds · 26K prompt (cached after round 1) · 10K out · calibrated ×1.3 on 12 runs" */
  detail: string;
  promptTokens: number;
  rounds: number;
  /** The measured correction applied (1 when there is no history yet). */
  calibration: number;
  /** How many completed runs the correction came from. */
  calibrationRuns: number;
}

/** The calibration window and its clamp: a median over few runs is noisy, so it is bounded. */
export const CALIBRATION_RUNS = 20;
export const CALIBRATION_CLAMP: [number, number] = [0.5, 3];

/** Median of actual ÷ estimate over completed runs, clamped; 1 with no history. Pure. */
export function calibrationFactor(pairs: Array<{ estimateUsd: number; costUsd: number }>): { factor: number; runs: number } {
  const ratios = pairs.filter((p) => p.estimateUsd > 0 && p.costUsd > 0).map((p) => p.costUsd / p.estimateUsd).sort((a, b) => a - b);
  if (ratios.length === 0) return { factor: 1, runs: 0 };
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { factor: Math.min(CALIBRATION_CLAMP[1], Math.max(CALIBRATION_CLAMP[0], Math.round(median * 100) / 100)), runs: ratios.length };
}

/**
 * The prefix (system + tools + history) is written to the cache on round 1 and read on every later round; each
 * round's tool results are written once and read by the rounds after it; every round thinks; the answer is output.
 * `calibration` (item 5) scales the model by the measured actual ÷ estimate of recent completed runs of the kind.
 */
export function estimateRunUsd(model: string, promptTokens: number, kind: RunKind, calibration: { factor: number; runs: number } = { factor: 1, runs: 0 }): RunEstimate {
  const p = ANALYST_PRICES[model];
  if (!p) throw new UnknownModelPriceError(model);
  const a = RUN_ALLOWANCE[kind];
  // The prefix is written once at its TTL's rate (1-hour on Opus — conservative: the first request of the hour pays it).
  const prefixWrite = model === 'claude-fable-5-1' ? p.cacheWrite5mPerMTok : p.cacheWrite1hPerMTok;
  let usd = (promptTokens * prefixWrite) / 1e6;
  for (let round = 2; round <= a.rounds; round++) {
    const earlierToolTokens = (round - 2) * a.toolTokensPerRound;
    usd += (promptTokens * p.cacheReadPerMTok + earlierToolTokens * p.cacheReadPerMTok + a.toolTokensPerRound * p.cacheWrite5mPerMTok) / 1e6;
  }
  const outputTokens = a.rounds * a.thinkingPerRound + a.answerTokens;
  usd += (outputTokens * p.outputPerMTok) / 1e6;
  usd *= calibration.factor;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  const cal = calibration.runs > 0 ? ` · calibrated ×${calibration.factor} on ${calibration.runs} run${calibration.runs === 1 ? '' : 's'}` : ' · uncalibrated (no completed runs of this kind yet)';
  return { usd: Math.round(usd * 100) / 100, detail: `~${a.rounds} rounds · ${k(promptTokens)} prompt (cached after round 1) · ${k(outputTokens)} out${cal}`, promptTokens, rounds: a.rounds, calibration: calibration.factor, calibrationRuns: calibration.runs };
}

export interface CapDecision {
  allowed: boolean;
  needsConfirmation: boolean;
  reason: string | null;
}

/** Before a run: over the per-run cap or the monthly budget → nothing is spent until the owner confirms this amount. */
export function capDecision(p: { estimateUsd: number; capRunUsd: number; spentMonthUsd: number; capMonthUsd: number; confirmedUsd?: number | null }): CapDecision {
  if (p.confirmedUsd !== null && p.confirmedUsd !== undefined && p.estimateUsd <= p.confirmedUsd + 1e-9) return { allowed: true, needsConfirmation: false, reason: null };
  if (p.estimateUsd > p.capRunUsd) return { allowed: false, needsConfirmation: true, reason: `This run is estimated at ${formatUsd(p.estimateUsd)}, above your ${formatUsd(p.capRunUsd)} per-run cap` };
  if (p.spentMonthUsd + p.estimateUsd > p.capMonthUsd) return { allowed: false, needsConfirmation: true, reason: `This run (${formatUsd(p.estimateUsd)}) would take this month to ${formatUsd(p.spentMonthUsd + p.estimateUsd)}, above your ${formatUsd(p.capMonthUsd)} monthly budget` };
  return { allowed: true, needsConfirmation: false, reason: null };
}

/** Between rounds: spent so far plus one more round above what was allowed → pause for confirmation. */
export function shouldPause(p: { spentUsd: number; nextRoundUsd: number; allowedUsd: number }): { pause: boolean; reason: string | null } {
  const projected = p.spentUsd + p.nextRoundUsd;
  if (projected > p.allowedUsd + 1e-9) return { pause: true, reason: `Spent ${formatUsd(p.spentUsd)} so far; the next round would take this run to about ${formatUsd(projected)}, above the ${formatUsd(p.allowedUsd)} allowed` };
  return { pause: false, reason: null };
}
