/**
 * Meta Marketing API configuration. Mirrors lib/ghl/config.ts: credentials
 * from the settings table (entered in Setup, stored as secrets, masked in
 * every response) with env-var fallback. Read-only: only GET insights.
 */

import { getSetting } from '../settings';

export const META_GRAPH_VERSION = 'v21.0';
export const META_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export const META_KEYS = {
  token: 'meta_access_token',
  adAccountId: 'meta_ad_account_id',
} as const;

export interface MetaConfig {
  token: string | null;
  /** Normalised to `act_<id>`. */
  adAccountId: string | null;
  configured: boolean;
  source: 'settings' | 'env' | 'none';
}

export function normalizeAdAccountId(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v.startsWith('act_') ? v : `act_${v}`;
}

export async function getMetaConfig(): Promise<MetaConfig> {
  const [storedToken, storedAccount] = await Promise.all([getSetting(META_KEYS.token), getSetting(META_KEYS.adAccountId)]);
  const envToken = process.env.META_ACCESS_TOKEN?.trim() || null;
  const envAccount = process.env.META_AD_ACCOUNT_ID?.trim() || null;

  const token = (storedToken?.trim() || null) ?? envToken;
  const adAccountId = normalizeAdAccountId((storedAccount?.trim() || null) ?? envAccount);
  const source: MetaConfig['source'] = storedToken?.trim() ? 'settings' : envToken ? 'env' : 'none';

  return { token, adAccountId, configured: Boolean(token && adAccountId), source };
}

export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${'•'.repeat(6)}${token.slice(-4)}`;
}
