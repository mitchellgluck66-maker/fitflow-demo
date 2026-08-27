/**
 * Google Ads API configuration. Same pattern as Meta/Stripe: settings table
 * (secrets masked) with env fallback. Google requires a developer token AND
 * an OAuth refresh token minted for the manager/customer account, which is
 * granted only after Google approves the developer token — so this config
 * has a `pending` state while fields are partially filled. Until then the
 * CSV upload on the Ads tab covers Google spend.
 */

import { getSetting } from '../settings';

export const GOOGLE_ADS_API_VERSION = 'v18';
export const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_ADS_KEYS = {
  developerToken: 'google_ads_developer_token',
  clientId: 'google_ads_client_id',
  clientSecret: 'google_ads_client_secret',
  refreshToken: 'google_ads_refresh_token',
  customerId: 'google_ads_customer_id',
  loginCustomerId: 'google_ads_login_customer_id',
} as const;

export const SECRET_FIELDS = new Set<string>([GOOGLE_ADS_KEYS.developerToken, GOOGLE_ADS_KEYS.clientSecret, GOOGLE_ADS_KEYS.refreshToken]);

export interface GoogleAdsConfig {
  developerToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  /** Digits only (dashes stripped). */
  customerId: string | null;
  loginCustomerId: string | null;
  /** Every required field present. */
  configured: boolean;
  /** At least one field present but not all — waiting on Google. */
  pending: boolean;
  present: Record<'developerToken' | 'clientId' | 'clientSecret' | 'refreshToken' | 'customerId' | 'loginCustomerId', boolean>;
  source: 'settings' | 'env' | 'none';
}

export function normalizeCustomerId(raw: string | null | undefined): string | null {
  const v = raw?.replace(/[^0-9]/g, '');
  return v ? v : null;
}

export async function getGoogleAdsConfig(): Promise<GoogleAdsConfig> {
  const [dev, cid, secret, refresh, customer, login] = await Promise.all([
    getSetting(GOOGLE_ADS_KEYS.developerToken),
    getSetting(GOOGLE_ADS_KEYS.clientId),
    getSetting(GOOGLE_ADS_KEYS.clientSecret),
    getSetting(GOOGLE_ADS_KEYS.refreshToken),
    getSetting(GOOGLE_ADS_KEYS.customerId),
    getSetting(GOOGLE_ADS_KEYS.loginCustomerId),
  ]);
  const env = (k: string) => process.env[k]?.trim() || null;
  const pick = (stored: string | null, envKey: string) => (stored?.trim() || null) ?? env(envKey);

  const developerToken = pick(dev, 'GOOGLE_ADS_DEVELOPER_TOKEN');
  const clientId = pick(cid, 'GOOGLE_ADS_CLIENT_ID');
  const clientSecret = pick(secret, 'GOOGLE_ADS_CLIENT_SECRET');
  const refreshToken = pick(refresh, 'GOOGLE_ADS_REFRESH_TOKEN');
  const customerId = normalizeCustomerId(pick(customer, 'GOOGLE_ADS_CUSTOMER_ID'));
  const loginCustomerId = normalizeCustomerId(pick(login, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'));

  const present = {
    developerToken: Boolean(developerToken),
    clientId: Boolean(clientId),
    clientSecret: Boolean(clientSecret),
    refreshToken: Boolean(refreshToken),
    customerId: Boolean(customerId),
    loginCustomerId: Boolean(loginCustomerId),
  };
  const required = [developerToken, clientId, clientSecret, refreshToken, customerId];
  const configured = required.every(Boolean);
  const pending = !configured && required.some(Boolean);
  const source: GoogleAdsConfig['source'] = dev?.trim() ? 'settings' : env('GOOGLE_ADS_DEVELOPER_TOKEN') ? 'env' : 'none';

  return { developerToken, clientId, clientSecret, refreshToken, customerId, loginCustomerId, configured, pending, present, source };
}

export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${'•'.repeat(6)}${token.slice(-4)}`;
}
