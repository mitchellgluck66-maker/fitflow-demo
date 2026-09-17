/**
 * Paid vs organic attribution — PURE (Phase G, item 2).
 *
 * A contact is `paid` when any of these first-touch signals says an ad
 * brought them in, checked in this order (the first hit is the recorded
 * reason, so the profile page can show exactly which signal decided it):
 *   1. an fbclid (Meta click id) or gclid (Google click id) — as a field, or
 *      as a query parameter of the landing URL
 *   2. utm_source, then the GHL contact source, then utm_medium, then GHL's
 *      session source, containing a PAID token: facebook / fb / meta /
 *      instagram / google / paid / cpc / ppc
 *      — unless that same value also says "organic" ("google organic" is not
 *      an ad).
 * Otherwise `organic`, with the reason listing what was checked, so a blank
 * attribution reads as "no paid signal", never as a silent default.
 *
 * `paid` is the strict class the marketing metrics use (Paid CAC, ROAS);
 * organic/direct must never leak into them (CLAUDE.md "Attribution classes").
 */

import type { AttributionClass } from '@/db/schema';

/** Tokens that mark a paid source. Extend here, in one place. */
export const PAID_TOKENS: readonly string[] = ['facebook', 'fb', 'meta', 'instagram', 'google', 'paid', 'cpc', 'ppc'];

export interface AttributionSignals {
  fbclid?: string | null;
  gclid?: string | null;
  /** Landing-page URL GHL recorded for the first touch. */
  url?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  /** GHL contact `source` (free text, e.g. "Facebook Ads", "Referral"). */
  source?: string | null;
  /** GHL `sessionSource` (e.g. "Paid Social", "Direct traffic"). */
  sessionSource?: string | null;
}

export interface AttributionResult {
  attributionClass: AttributionClass;
  /** Human-readable: which signal decided it. */
  reason: string;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when the value carries a paid token and does not also say "organic". */
export function isPaidValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = tokens(value);
  if (t.includes('organic')) return false;
  return t.some((x) => PAID_TOKENS.includes(x));
}

/** Pull fbclid / gclid out of a landing URL's query string. */
export function clickIdsFromUrl(url: string | null | undefined): { fbclid: string | null; gclid: string | null } {
  if (!url) return { fbclid: null, gclid: null };
  const grab = (key: string): string | null => {
    const m = url.match(new RegExp(`[?&#]${key}=([^&#\\s]+)`, 'i'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  return { fbclid: grab('fbclid'), gclid: grab('gclid') };
}

export function classifyAttribution(s: AttributionSignals): AttributionResult {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const fromUrl = clickIdsFromUrl(s.url);
  const fbclid = clean(s.fbclid) ?? fromUrl.fbclid;
  const gclid = clean(s.gclid) ?? fromUrl.gclid;

  if (fbclid) return { attributionClass: 'paid', reason: `fbclid present (Meta click id${clean(s.fbclid) ? '' : ', from landing URL'})` };
  if (gclid) return { attributionClass: 'paid', reason: `gclid present (Google click id${clean(s.gclid) ? '' : ', from landing URL'})` };

  const checks: Array<[label: string, value: string | null]> = [
    ['utm_source', clean(s.utmSource)],
    ['source', clean(s.source)],
    ['utm_medium', clean(s.utmMedium)],
    ['session source', clean(s.sessionSource)],
  ];
  for (const [label, value] of checks) {
    if (isPaidValue(value)) return { attributionClass: 'paid', reason: `${label} "${value}" matches a paid pattern` };
  }

  const seen = checks
    .filter(([, v]) => v)
    .map(([l, v]) => `${l} "${v}"`)
    .join(', ');
  return {
    attributionClass: 'organic',
    reason: seen ? `no paid signal — no click id; ${seen}` : 'no paid signal — no click id, no utm_source, no source',
  };
}

export function isAttributionClass(value: unknown): value is AttributionClass {
  return value === 'paid' || value === 'organic';
}
