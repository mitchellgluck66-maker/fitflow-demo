/**
 * Anthropic API configuration. Mirrors lib/meta/config.ts: key from the
 * settings table (Setup, stored as a secret, masked everywhere) with an
 * ANTHROPIC_API_KEY env fallback. Model is overridable via settings.
 */

import { getSetting } from '../settings';

export const ANTHROPIC_KEYS = {
  apiKey: 'anthropic_api_key',
  model: 'anthropic_model',
} as const;

/** Sonnet-class: cheap enough to run nightly over a small metrics JSON. */
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const MODEL_OPTIONS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'] as const;

export interface AnthropicConfig {
  key: string | null;
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  model: string;
}

export async function getAnthropicConfig(): Promise<AnthropicConfig> {
  const [stored, storedModel] = await Promise.all([getSetting(ANTHROPIC_KEYS.apiKey), getSetting(ANTHROPIC_KEYS.model)]);
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const key = (stored?.trim() || null) ?? envKey;
  return {
    key,
    configured: Boolean(key),
    source: stored?.trim() ? 'settings' : envKey ? 'env' : 'none',
    model: storedModel?.trim() || DEFAULT_MODEL,
  };
}

export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${'•'.repeat(6)}${token.slice(-4)}`;
}
