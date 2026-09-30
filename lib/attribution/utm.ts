/**
 * UTM / click-id parameters from a landing URL (F3, 2026-09-30).
 *
 * The 2026-09-29 verification: contacts.utm_campaign was set on 27 of 316 followed contacts while 206 carried the
 * campaign inside attribution_url, URL-encoded (`utm_campaign=%28July+16%29+New+VSL+Landing+Page…`) — and those,
 * decoded, match the Meta campaign names exactly. The campaign table's FitFlow-tracked columns (leads, clients,
 * initial cash, per-campaign ROAS) were therefore all zero.
 *
 * Pure. Decodes `+` as a space and %xx (a second pass only when the first left a valid %xx — double encoding);
 * a malformed escape never throws, the valid sequences around it are still decoded. GHL's structured fields win:
 * `fillFromUrl` only fills what is empty.
 */

export interface UrlParams {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  fbclid: string | null;
  gclid: string | null;
}

const KEYS: Record<string, keyof UrlParams> = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
  fbclid: 'fbclid',
  gclid: 'gclid',
};

const HEX = /%[0-9A-Fa-f]{2}/;

function decodeOnce(v: string): string {
  const plus = v.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    // Malformed somewhere: decode each valid run of %xx bytes on its own, leave the rest as written.
    return plus.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** One parameter value: + → space, %xx decoded (twice only if it was double-encoded), trimmed; empty → null. */
export function decodeParam(raw: string): string | null {
  let v = decodeOnce(raw);
  if (HEX.test(v) && /%25[0-9A-Fa-f]{2}/.test(raw)) v = decodeOnce(v);
  v = v.trim();
  return v === '' ? null : v;
}

/** Every UTM / click-id parameter in a URL's query string (and fragment). First occurrence wins. */
export function parseUrlParams(url: string | null | undefined): UrlParams {
  const out: UrlParams = { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, fbclid: null, gclid: null };
  if (!url) return out;
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const parts = [q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '', h >= 0 ? url.slice(h + 1) : ''].join('&');
  for (const pair of parts.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = (eq >= 0 ? pair.slice(0, eq) : pair).trim().toLowerCase();
    const field = KEYS[key];
    if (!field || out[field] !== null || eq < 0) continue;
    out[field] = decodeParam(pair.slice(eq + 1));
  }
  return out;
}

/** Fill only the EMPTY fields of `current` from the URL; report which ones were filled. */
export function fillFromUrl(current: Partial<UrlParams>, url: string | null | undefined): { values: UrlParams; filled: Array<keyof UrlParams> } {
  const parsed = parseUrlParams(url);
  const values = {} as UrlParams;
  const filled: Array<keyof UrlParams> = [];
  for (const k of Object.keys(parsed) as Array<keyof UrlParams>) {
    const have = current[k];
    if (have != null && String(have).trim() !== '') values[k] = have;
    else {
      values[k] = parsed[k];
      if (parsed[k] !== null) filled.push(k);
    }
  }
  return { values, filled };
}
