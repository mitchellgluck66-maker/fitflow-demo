/**
 * FitFlow Analyst — configuration (docs/plan-analyst-2026-09-30.md).
 *
 * The Analyst has its own model settings and its own request shape; the small
 * features (Ask, Insights, narrative, remap) keep `lib/anthropic/client.ts#askClaude`
 * and `MODEL_OPTIONS` untouched. The API key is the one stored in Setup → Anthropic.
 */

import { getSetting } from '../settings';
import { getAnthropicConfig } from '../anthropic/config';

export const ANALYST_KEYS = {
  modelDefault: 'analyst_model_default',
  modelDeep: 'analyst_model_deep',
  effort: 'analyst_effort',
  /** How the final answer is requested: `format` (output_config.format) or `submit_answer` (strict tool). Decided by the probe. */
  answerMode: 'analyst_answer_mode',
  capRunUsd: 'analyst_cap_run_usd',
  capMonthUsd: 'analyst_cap_month_usd',
  ownerProfile: 'analyst_owner_profile',
  briefBuiltAt: 'analyst_brief_built_at',
} as const;

export type AnalystModel = 'claude-opus-5-5' | 'claude-fable-5-1';
export const ANALYST_MODELS: { default: AnalystModel; deep: AnalystModel } = { default: 'claude-opus-5-5', deep: 'claude-fable-5-1' };
export const ANALYST_MODEL_OPTIONS: readonly AnalystModel[] = ['claude-opus-5-5', 'claude-fable-5-1'];

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AnswerMode = 'format' | 'submit_answer';

/** Beta headers, each paired with the field it enables (the wire contract test checks both directions). */
export const ANALYST_BETAS = {
  /** `thinking.display: "updates"` — progress updates between tool calls as text. */
  displayUpdates: 'thinking-display-updates-2026-08-18',
  /** `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` — a changed prefix drops old thinking instead of a 400. */
  bindingControls: 'thinking-binding-controls-2026-08-01',
  /** The on-demand `compaction` parameter and every later request that carries the signed block. */
  compaction: 'compact-2026-09-04',
} as const;

/** Defaults; every one is overridable in Setup → Analyst. Costs are USD (amendment 6). */
export const ANALYST_DEFAULTS = {
  effort: 'high' as Effort,
  answerMode: 'format' as AnswerMode,
  capRunUsd: 3,
  capMonthUsd: 150,
};

export interface AnalystConfig {
  key: string | null;
  configured: boolean;
  modelDefault: AnalystModel;
  modelDeep: AnalystModel;
  effort: Effort;
  answerMode: AnswerMode;
  capRunUsd: number;
  capMonthUsd: number;
}

function asModel(v: string | null, fallback: AnalystModel): AnalystModel {
  return (ANALYST_MODEL_OPTIONS as readonly string[]).includes(v ?? '') ? (v as AnalystModel) : fallback;
}

function asNumber(v: string | null, fallback: number): number {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getAnalystConfig(): Promise<AnalystConfig> {
  const [base, modelDefault, modelDeep, effort, answerMode, capRun, capMonth] = await Promise.all([
    getAnthropicConfig(),
    getSetting(ANALYST_KEYS.modelDefault),
    getSetting(ANALYST_KEYS.modelDeep),
    getSetting(ANALYST_KEYS.effort),
    getSetting(ANALYST_KEYS.answerMode),
    getSetting(ANALYST_KEYS.capRunUsd),
    getSetting(ANALYST_KEYS.capMonthUsd),
  ]);
  const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  return {
    key: base.key,
    configured: base.configured,
    modelDefault: asModel(modelDefault, ANALYST_MODELS.default),
    modelDeep: asModel(modelDeep, ANALYST_MODELS.deep),
    effort: efforts.includes((effort ?? '') as Effort) ? (effort as Effort) : ANALYST_DEFAULTS.effort,
    answerMode: answerMode === 'submit_answer' ? 'submit_answer' : ANALYST_DEFAULTS.answerMode,
    capRunUsd: asNumber(capRun, ANALYST_DEFAULTS.capRunUsd),
    capMonthUsd: asNumber(capMonth, ANALYST_DEFAULTS.capMonthUsd),
  };
}
