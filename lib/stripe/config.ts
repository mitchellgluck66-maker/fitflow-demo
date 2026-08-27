/**
 * Stripe configuration — READ-ONLY restricted key.
 *
 * Credentials resolve from the settings table first (entered in Setup,
 * stored with is_secret=true, masked in every response) with env-var fallback
 * (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET). Nothing here ever writes to
 * Stripe; the client is GET-only.
 */

import { getSetting } from '../settings';

export const STRIPE_BASE_URL = 'https://api.stripe.com';

export const STRIPE_KEYS = {
  secretKey: 'stripe_secret_key',
  webhookSecret: 'stripe_webhook_secret',
} as const;

export const REQUIRED_STRIPE_PERMISSIONS = [
  'Charges: read',
  'Customers: read',
  'Subscriptions: read',
  'Balance: read',
] as const;

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  configured: boolean;
  hasWebhookSecret: boolean;
  source: 'settings' | 'env' | 'none';
  /** rk_ (restricted, what we want) | sk_ (full — warn) | unknown */
  keyKind: 'restricted' | 'full' | 'unknown' | 'none';
}

export async function getStripeConfig(): Promise<StripeConfig> {
  const [stored, storedWebhook] = await Promise.all([
    getSetting(STRIPE_KEYS.secretKey),
    getSetting(STRIPE_KEYS.webhookSecret),
  ]);
  const envKey = process.env.STRIPE_SECRET_KEY?.trim() || null;
  const envWebhook = process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;

  const secretKey = (stored?.trim() || null) ?? envKey;
  const webhookSecret = (storedWebhook?.trim() || null) ?? envWebhook;
  const source: StripeConfig['source'] = stored?.trim() ? 'settings' : envKey ? 'env' : 'none';

  const keyKind: StripeConfig['keyKind'] = !secretKey
    ? 'none'
    : secretKey.startsWith('rk_')
      ? 'restricted'
      : secretKey.startsWith('sk_')
        ? 'full'
        : 'unknown';

  return {
    secretKey,
    webhookSecret,
    configured: Boolean(secretKey),
    hasWebhookSecret: Boolean(webhookSecret),
    source,
    keyKind,
  };
}

export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 3)}${'•'.repeat(6)}${token.slice(-4)}`;
}

/** A key must be a Stripe secret/restricted key; anything else is rejected on save. */
export function isPlausibleStripeKey(value: string): boolean {
  return /^(rk|sk)_(live|test)_[A-Za-z0-9]{8,}$/.test(value.trim());
}
