/**
 * Google Ads API client: OAuth refresh → GAQL searchStream. Secrets never
 * appear in recorded errors. These are POSTs to Google's API (reads by
 * GAQL semantics) — GoHighLevel remains strictly GET-only elsewhere.
 */

import { GOOGLE_ADS_BASE_URL, GOOGLE_OAUTH_TOKEN_URL, getGoogleAdsConfig, type GoogleAdsConfig } from './config';
import { GoogleAdsRowSchema, GoogleAdsStreamSchema, GoogleTokenResponseSchema, parseMany, type GoogleAdsRow } from './schemas';

let requestCounter = 0;
export function getGoogleAdsRequestCount(): number {
  return requestCounter;
}

function scrub(text: string, config: GoogleAdsConfig): string {
  let out = text;
  for (const s of [config.developerToken, config.clientSecret, config.refreshToken]) {
    if (s) out = out.split(s).join('[redacted]');
  }
  return out.slice(0, 400);
}

export interface GoogleResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function getAccessToken(config?: GoogleAdsConfig): Promise<GoogleResult<string>> {
  const cfg = config ?? (await getGoogleAdsConfig());
  if (!cfg.configured) return { ok: false, status: 0, data: null, error: 'Google Ads is not fully configured.' };
  requestCounter += 1;
  try {
    const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId!,
        client_secret: cfg.clientSecret!,
        refresh_token: cfg.refreshToken!,
        grant_type: 'refresh_token',
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, data: null, error: `OAuth ${res.status}: ${scrub(text, cfg)}` };
    const parsed = GoogleTokenResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, status: res.status, data: null, error: 'OAuth token response failed validation' };
    return { ok: true, status: res.status, data: parsed.data.access_token };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: scrub(err instanceof Error ? err.message : String(err), cfg) };
  }
}

export async function gaql(query: string, config?: GoogleAdsConfig): Promise<GoogleResult<GoogleAdsRow[]> & { rejected: number; warnings: string[] }> {
  const cfg = config ?? (await getGoogleAdsConfig());
  const token = await getAccessToken(cfg);
  if (!token.ok || !token.data) return { ok: false, status: token.status, data: null, error: token.error, rejected: 0, warnings: [] };

  requestCounter += 1;
  try {
    const res = await fetch(`${GOOGLE_ADS_BASE_URL}/customers/${cfg.customerId}/googleAds:searchStream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.data}`,
        'developer-token': cfg.developerToken!,
        ...(cfg.loginCustomerId ? { 'login-customer-id': cfg.loginCustomerId } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, data: null, error: `Google Ads ${res.status}: ${scrub(text, cfg)}`, rejected: 0, warnings: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, data: null, error: 'Google Ads response was not JSON', rejected: 0, warnings: [] };
    }
    const stream = GoogleAdsStreamSchema.safeParse(raw);
    if (!stream.success) return { ok: false, status: res.status, data: null, error: 'Google Ads stream failed validation', rejected: 0, warnings: [] };
    const rows = stream.data.flatMap((b) => b.results);
    const parsed = parseMany(GoogleAdsRowSchema, rows, 'google ads row');
    return { ok: true, status: res.status, data: parsed.valid, rejected: parsed.rejected, warnings: parsed.warnings };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: scrub(err instanceof Error ? err.message : String(err), cfg), rejected: 0, warnings: [] };
  }
}

export function spendReportQuery(since: string, until: string): string {
  return `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
}

export async function fetchSpendReport(since: string, until: string, config?: GoogleAdsConfig) {
  return gaql(spendReportQuery(since, until), config);
}

export async function testConnection(): Promise<{ ok: boolean; configured: boolean; pending: boolean; message: string; customerId?: string }> {
  const cfg = await getGoogleAdsConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      pending: cfg.pending,
      message: cfg.pending
        ? 'Waiting on Google: fill in the remaining fields once the developer token is approved and OAuth is granted.'
        : 'Google Ads is not connected. Upload the Google Ads CSV export on the Ads tab in the meantime.',
    };
  }
  const res = await gaql('SELECT customer.id FROM customer LIMIT 1', cfg);
  if (!res.ok) return { ok: false, configured: true, pending: false, message: res.error ?? 'Connection failed' };
  return { ok: true, configured: true, pending: false, message: 'Connected to Google Ads.', customerId: String(res.data?.[0]?.customer?.id ?? cfg.customerId) };
}
