/**
 * Meta Marketing API client — GET only. Every response is Zod-validated.
 * The access token travels in the query string (Meta's convention) and is
 * scrubbed from anything we record.
 */

import type { z } from 'zod';
import { META_BASE_URL, getMetaConfig } from './config';
import { MetaAccountSchema, MetaInsightRowSchema, MetaPagedSchema, parseMany, type MetaAccount, type MetaInsightRow } from './schemas';

export interface MetaResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

let requestCounter = 0;
export function getMetaRequestCount(): number {
  return requestCounter;
}

function scrub(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join('[token]').replace(/access_token=[^&\s"']+/g, 'access_token=[token]');
}

export async function metaRequest<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  schema: z.ZodType<T>,
  /** Full URL (from paging.next) overrides path+query. */
  absoluteUrl?: string,
): Promise<MetaResult<T>> {
  const config = await getMetaConfig();
  if (!config.configured) {
    return { ok: false, status: 0, data: null, error: 'Meta Ads is not connected. Add an access token and ad account id in Setup.' };
  }

  let url: URL;
  if (absoluteUrl) {
    url = new URL(absoluteUrl);
  } else {
    url = new URL(`${META_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('access_token', config.token!);

  requestCounter += 1;
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    let raw: unknown = null;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    if (!res.ok) {
      const msg =
        raw && typeof raw === 'object' && 'error' in raw && (raw as { error?: { message?: string } }).error?.message
          ? (raw as { error: { message: string } }).error.message
          : text.slice(0, 300);
      return { ok: false, status: res.status, data: null, error: scrub(`Meta ${res.status} GET ${path}: ${msg}`, config.token) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, status: res.status, data: null, error: `Meta response for ${path} failed validation at ${issue?.path.join('.')}: ${issue?.message}` };
    }
    return { ok: true, status: res.status, data: parsed.data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: scrub(err instanceof Error ? err.message : String(err), config.token) };
  }
}

/** One cheap request: confirms token + account id + permissions. */
export async function testConnection(): Promise<{ ok: boolean; configured: boolean; message: string; account?: MetaAccount }> {
  const config = await getMetaConfig();
  if (!config.configured) {
    return { ok: false, configured: false, message: 'Not connected. Paste a long-lived access token and the ad account id.' };
  }
  const res = await metaRequest(`/${config.adAccountId}`, { fields: 'id,name,currency,account_status' }, MetaAccountSchema);
  if (!res.ok || !res.data) return { ok: false, configured: true, message: res.error ?? 'Connection failed' };
  return { ok: true, configured: true, message: `Connected to ${res.data.name ?? res.data.id} (${res.data.currency ?? 'USD'}).`, account: res.data };
}

export interface InsightsFetch {
  rows: MetaInsightRow[];
  rejected: number;
  warnings: string[];
  requests: number;
  error?: string;
}

const MAX_PAGES = 50;

/** Daily insights at ad level for [since, until] (YYYY-MM-DD, inclusive). */
export async function fetchInsights(params: { since: string; until: string; level?: 'ad' }): Promise<InsightsFetch> {
  const config = await getMetaConfig();
  const out: InsightsFetch = { rows: [], rejected: 0, warnings: [], requests: 0 };
  let next: string | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    const res = await metaRequest(
      `/${config.adAccountId}/insights`,
      {
        fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,reach,frequency,cpm,cpc,inline_link_clicks,actions',
        level: params.level ?? 'ad',
        time_increment: 1,
        time_range: JSON.stringify({ since: params.since, until: params.until }),
        limit: 500,
      },
      MetaPagedSchema,
      next,
    );
    out.requests += 1;
    page += 1;
    if (!res.ok || !res.data) {
      out.error = res.error;
      return out;
    }
    const parsed = parseMany(MetaInsightRowSchema, res.data.data, 'insight');
    out.rows.push(...parsed.valid);
    out.rejected += parsed.rejected;
    out.warnings.push(...parsed.warnings);
    if (!res.data.paging?.next) break;
    next = res.data.paging.next;
  }
  if (page >= MAX_PAGES) out.warnings.push(`Insights paging stopped at ${MAX_PAGES} pages.`);
  return out;
}
