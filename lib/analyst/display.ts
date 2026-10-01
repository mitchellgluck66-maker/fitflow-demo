/**
 * Display strings next to refs (tuning item 3, 2026-09-30) — PURE. Every money or ratio leaf of a
 * tool result gets a sibling `<key>Text` holding EXACTLY the rendering the verifier accepts
 * (`lib/analyst/verify.ts#renders`): cents → "$3,697.68 CAD" (whole dollars stay whole: "$250 CAD"),
 * a ratio → "41.2%" or, for multiples (ROAS, LTV:CAC, frequency), "2.1×". The contract tells the
 * model to copy them verbatim, so a repair over rendering ("$3.70k" vs "$3,697.68") cannot happen.
 *
 * Why a sibling and not a replacement: the ledger addresses numeric leaves by JSON path
 * (`r2:data.marketing.spendCents`); a sibling keeps every path and every ref unchanged. Strings are
 * unsigned — the verifier's number token has no sign — so a negative value reads "$697.68 CAD" and
 * the model says "down" in words. Counts and plain numbers need no string: their text IS the number.
 */

import { unitForPath } from './ledger';

const MULTIPLE = /(roas|ltvtocac|frequency)/i;

/** The verifier-accepted rendering of one value under its path's unit; null when it has no string form. */
export function displayFor(path: string, value: number, currency: string): string | null {
  const unit = unitForPath(path);
  if (unit === 'cents') {
    const abs = Math.abs(value) / 100;
    const whole = Number.isInteger(abs);
    return `$${abs.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} ${currency}`;
  }
  if (unit === 'ratio') {
    const abs = Math.abs(value);
    if (MULTIPLE.test(path.split(/[.[]/).filter(Boolean).slice(-2).join('.'))) return `${(Math.round(abs * 10) / 10).toFixed(1)}×`;
    return `${(Math.round(abs * 1000) / 10).toFixed(1)}%`;
  }
  return null;
}

/** The key the display string lives under, next to its number. */
export const displayKey = (key: string) => `${key}Text`;

/**
 * Copy `data` with a `<key>Text` sibling for every money / ratio leaf (objects only; a bare number in an
 * array has no key to sit next to). Existing string fields are never overwritten.
 */
export function withDisplayStrings<T>(data: T, currency: string, path = 'data'): T {
  if (Array.isArray(data)) return data.map((x, i) => withDisplayStrings(x, currency, `${path}[${i}]`)) as unknown as T;
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      const text = displayFor(p, v, currency);
      const dk = displayKey(k);
      if (text !== null && !(dk in (data as Record<string, unknown>))) out[dk] = text;
      continue;
    }
    out[k] = v && typeof v === 'object' ? withDisplayStrings(v, currency, p) : v;
  }
  return out as T;
}
