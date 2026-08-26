/**
 * GoHighLevel integration configuration.
 *
 * Credentials resolve from two places, in priority order:
 *   1. The app's own settings table — what you paste into the Setup page.
 *   2. Environment variables in .env.local.
 *
 * The in-app path exists so the tool is usable without editing files and
 * restarting a server. The env path exists because that is the safer place for
 * a secret, and it wins nothing by being second — it is simply the fallback
 * when nothing has been entered in the UI.
 *
 * SECURITY NOTE: a token entered through the UI is stored in the local SQLite
 * database in plain text. That is an acceptable trade for a single-user tool
 * running on one machine, and it is what makes "paste and go" possible — but it
 * is not appropriate for a shared or hosted deployment. For anything
 * multi-user, use the env var and leave the UI field blank.
 */

import { getSetting } from '../settings';

export const GHL_BASE_URL = 'https://services.leadconnectorhq.com';

/**
 * The Version header is MANDATORY on every request - omitting it errors.
 * Calendar endpoints moved to v3; contacts and opportunities are still on the
 * 2021-07-28 revision. Sending the wrong one is the most likely cause of a
 * confusing 4xx, so we pick per endpoint family rather than using a global.
 */
export const GHL_API_VERSION = {
  calendars: 'v3',
  contacts: '2021-07-28',
  opportunities: '2021-07-28',
  locations: '2021-07-28',
  users: '2021-07-28',
} as const;

export type GhlApiFamily = keyof typeof GHL_API_VERSION;

export const REQUIRED_SCOPES = [
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'contacts.readonly',
  'contacts.write',
  'opportunities.readonly',
  'opportunities.write',
  'locations/customFields.readonly',
  'users.readonly',
] as const;

/** Settings keys for credentials entered through the UI. */
export const CREDENTIAL_KEYS = {
  token: 'ghl_api_token',
  locationId: 'ghl_location_id',
  dryRun: 'ghl_dry_run',
  notifyOnWrite: 'ghl_notify_on_write',
  followedCalendars: 'ghl_followed_calendars',
} as const;

export interface GhlConfig {
  token: string | null;
  locationId: string | null;
  /** When true, no HTTP request leaves the process - payloads are logged instead. */
  dryRun: boolean;
  /** Whether GHL should fire its own notifications/automations on our writes. */
  notifyOnWrite: boolean;
  configured: boolean;
  /** Where the credentials came from, for display in the UI. */
  source: 'settings' | 'env' | 'none';
}

/**
 * Resolve the active configuration.
 *
 * Async because the primary source is the database. Every call site is already
 * in an async context (API routes and the sync engine), so this costs nothing.
 */
export async function getGhlConfig(): Promise<GhlConfig> {
  const [storedToken, storedLocation, storedDryRun, storedNotify] = await Promise.all([
    getSetting(CREDENTIAL_KEYS.token),
    getSetting(CREDENTIAL_KEYS.locationId),
    getSetting(CREDENTIAL_KEYS.dryRun),
    getSetting(CREDENTIAL_KEYS.notifyOnWrite),
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

  const configured = Boolean(token && locationId);

  // Dry run unless explicitly turned off AND credentials are present. Defaulting
  // to dry-run means a missing or half-finished setup can never cause an
  // accidental write to a real GoHighLevel account.
  const explicitlyLive =
    storedDryRun !== null ? storedDryRun === 'false' : process.env.GHL_DRY_RUN === 'false';

  return {
    token,
    locationId,
    dryRun: !configured || !explicitlyLive,
    notifyOnWrite:
      storedNotify !== null
        ? storedNotify === 'true'
        : process.env.GHL_NOTIFY_ON_WRITE === 'true',
    configured,
    source,
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
  /** We stay well under the ceiling - a nightly batch has no reason to sprint. */
  safeConcurrency: 4,
  minIntervalMs: 120,
} as const;
