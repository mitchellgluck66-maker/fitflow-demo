/**
 * Stripe API client — GET only, restricted key, Zod at the boundary.
 * The key never appears in an error message.
 */

import type { z } from 'zod';
import { STRIPE_BASE_URL, getStripeConfig } from './config';
import { StripeListSchema, StripeBalanceSchema } from './schemas';

export type StripeQuery = Record<string, string | number | boolean | string[] | Record<string, string | number> | undefined>;

export interface StripeResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  notConfigured?: boolean;
}

let requestCounter = 0;
export function getStripeRequestCount(): number {
  return requestCounter;
}

/** Stripe uses form-style nesting: created[gte]=1&expand[]=data.customer */
export function encodeQuery(query: StripeQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(`${key}[]`, String(v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) params.set(`${key}[${k}]`, String(v));
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export async function stripeRequest<T = unknown>(
  path: string,
  query: StripeQuery = {},
  schema?: z.ZodType<T>,
): Promise<StripeResult<T>> {
  const config = await getStripeConfig();
  if (!config.configured || !config.secretKey) {
    return { ok: false, status: 0, data: null, notConfigured: true, error: 'Stripe is not connected. Add a restricted key in Setup.' };
  }

  const qs = encodeQuery(query);
  const url = `${STRIPE_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  requestCounter += 1;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.secretKey}`, Accept: 'application/json' },
    });
    const text = await response.text();
    let raw: unknown = null;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }

    if (!response.ok) {
      const message =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error: { message?: string } }).error?.message ?? '')
          : text.slice(0, 200);
      return { ok: false, status: response.status, data: null, error: `Stripe ${response.status} GET ${path}: ${message}` };
    }

    if (schema) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, status: response.status, data: null, error: `Stripe response for ${path} failed validation at ${issue?.path.join('.')}: ${issue?.message}` };
      }
      return { ok: true, status: response.status, data: parsed.data };
    }
    return { ok: true, status: response.status, data: raw as T };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Auto-paging list. Returns raw items (caller validates per-item). */
export async function listAll(path: string, query: StripeQuery = {}, maxPages = 100): Promise<{ items: unknown[]; requests: number; error?: string }> {
  const items: unknown[] = [];
  let requests = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await stripeRequest(path, { ...query, limit: 100, starting_after: startingAfter }, StripeListSchema);
    requests += 1;
    if (!res.ok || !res.data) return { items, requests, error: res.error };
    items.push(...res.data.data);
    if (!res.data.has_more || res.data.data.length === 0) break;
    const last = res.data.data[res.data.data.length - 1] as { id?: string };
    if (!last?.id) break;
    startingAfter = last.id;
  }
  return { items, requests };
}

/** One cheap read to prove the key works. Balance first; charges as fallback. */
export async function testConnection(): Promise<{ ok: boolean; configured: boolean; message: string }> {
  const config = await getStripeConfig();
  if (!config.configured) return { ok: false, configured: false, message: 'No Stripe key set. Add a restricted key (rk_…) in Setup.' };

  const warn = config.keyKind === 'full' ? ' Note: this is a full secret key (sk_) — a restricted read-only key (rk_) is safer.' : '';
  const balance = await stripeRequest('/v1/balance', {}, StripeBalanceSchema);
  if (balance.ok) return { ok: true, configured: true, message: `Connected to Stripe (read-only).${warn}` };

  if (balance.status === 403 || balance.status === 401) {
    const charges = await stripeRequest('/v1/charges', { limit: 1 }, StripeListSchema);
    if (charges.ok) return { ok: true, configured: true, message: `Connected to Stripe (charges readable; balance permission missing).${warn}` };
    return { ok: false, configured: true, message: charges.error ?? 'Stripe rejected the key.' };
  }
  return { ok: false, configured: true, message: balance.error ?? 'Could not reach Stripe.' };
}
