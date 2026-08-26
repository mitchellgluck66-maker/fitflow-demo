/**
 * GoHighLevel integration configuration.
 *
 * FitFlow is READ-ONLY against GoHighLevel (CLAUDE.md rule 1). The only thing
 * this module can enable is reading. The legacy write-back engine
 * (lib/ghl/sync.ts + lib/ghl/mapping.ts) is dormant behind ENABLE_WRITEBACK,
 * which is hard-off: it is a compile-time constant, not an env var, so no
 * deployment configuration can flip it.
 *
 * Credentials resolve from two places, in priority order:
 *   1. The settings table — what you paste into the Setup page (stored with
 *      is_secret=true, never returned unmasked).
 *   2. Environment variables (GHL_API_TOKEN, GHL_LOCATION_ID).
 */

import { getSetting } from '../settings';

/**
 * HARD-OFF. Do not change this to read from process.env. If a task appears to
 * need a GHL write, stop and ask Mitchell (CLAUDE.md rule 1).
 */
export const ENABLE_WRITEBACK = false as const;

export const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

/**
 * The Version header is MANDATORY on every request. Calendar endpoints are on
 * v3; contacts and opportunities are still on the 2021-07-28 revision. Wrong
 * version → confusing 4xx, so we pick per endpoint family.
 */
export const GHL_API_VERSION = {
  calendars: 'v3',
  contacts: '2021-07-28',
  opportunities: '2021-07-28',
  locations: '2021-07-28',
  users: '2021-07-28',
} as const;

export type GhlApiFamily = keyof typeof GHL_API_VERSION;

/** Read-only scopes are all a Private Integration Token needs for FitFlow. */
export const REQUIRED_SCOPES = [
  'calendars.readonly',
  'calendars/events.readonly',
  'contacts.readonly',
  'opportunities.readonly',
  'locations.readonly',
  'users.readonly',
] as const;

/** Settings keys for credentials entered through the UI. */
export const CREDENTIAL_KEYS = {
  token: 'ghl_api_token',
  locationId: 'ghl_location_id',
  followedCalendars: 'ghl_followed_calendars',
  // Legacy (dormant write-back only)
  dryRun: 'ghl_dry_run',
  notifyOnWrite: 'ghl_notify_on_write',
} as const;

export interface GhlConfig {
  token: string | null;
  locationId: string | null;
  configured: boolean;
  /** Where the credentials came from, for display in the UI. */
  source: 'settings' | 'env' | 'none';
  /** Always false unless ENABLE_WRITEBACK is flipped in source. */
  writebackEnabled: boolean;
  /** Legacy fields the dormant write-back engine reads. Always dry-run. */
  dryRun: boolean;
  notifyOnWrite: boolean;
}

export async function getGhlConfig(): Promise<GhlConfig> {
  const [storedToken, storedLocation] = await Promise.all([
    getSetting(CREDENTIAL_KEYS.token),
    getSetting(CREDENTIAL_KEYS.locationId),
  ]);

  const envToken = process.env.GHL_API_TOKEN?.trim() || null;
  const envLocation = process.env.GHL_LOCATION_ID?.trim() || null;

  const token = (storedToken?.trim() || null) ?? envToken;
  const locationId = (storedLocation?.trim() || null) ?? envLocation;

  const source: GhlConfig['source'] = storedToken?.trim()
    ? 'settings'
    : envToken
      ? 'env'
      : 'none';

  return {
    token,
    locationId,
    configured: Boolean(token && locationId),
    source,
    writebackEnabled: ENABLE_WRITEBACK,
    dryRun: true,
    notifyOnWrite: false,
  };
}

/** Show only the tail of a token, so the UI can confirm which one is saved. */
export function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${'•'.repeat(6)}${token.slice(-4)}`;
}

/** Rate limits: 100 requests / 10s burst, 200k/day, per app per location. */
export const RATE_LIMIT = {
  burstMax: 100,
  burstWindowMs: 10_000,
  safeConcurrency: 4,
  minIntervalMs: 120,
} as const;
