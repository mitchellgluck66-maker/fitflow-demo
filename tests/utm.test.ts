/**
 * F3 (2026-09-30): utm_* parsed from the landing URL. 206 of 316 followed contacts carried the campaign only inside
 * attribution_url (URL-encoded) and the campaign table's FitFlow columns were all zero. Parsing is pure and never
 * throws; GHL's structured fields win; a first-run job fills every existing contact, then says "done".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, contacts } from '@/db';
import { parseUrlParams, fillFromUrl, decodeParam } from '@/lib/attribution/utm';
import { clickIdsFromUrl } from '@/lib/attribution/classify';
import { runUtmBackfill } from '@/lib/attribution/utmBackfill';

const PROD_URL = 'https://thefitphysician.com/vsl?utm_source=facebook&utm_medium=paid&utm_campaign=%28July+16%29+New+VSL+Landing+Page+%2F+Doctor+Job&utm_content=Video+3&fbclid=IwAR0abc';

describe('parseUrlParams (pure)', () => {
  it('the production shape: + and %xx decoded, the campaign matches the Meta campaign name', () => {
    expect(parseUrlParams(PROD_URL)).toEqual({
      utmSource: 'facebook', utmMedium: 'paid', utmCampaign: '(July 16) New VSL Landing Page / Doctor Job', utmContent: 'Video 3', utmTerm: null, fbclid: 'IwAR0abc', gclid: null,
    });
  });

  it('double encoding, a malformed escape, fragment params, case, first occurrence, empty values', () => {
    expect(decodeParam('%2528July%252016%2529')).toBe('(July 16)');
    expect(() => parseUrlParams('https://x.io/?utm_campaign=100%25+real+%E0%A4%A&utm_term=a%zzb')).not.toThrow();
    expect(parseUrlParams('https://x.io/?utm_campaign=100%25+real+%E0%A4%A').utmCampaign).toBe('100% real %E0%A4%A');
    expect(parseUrlParams('https://x.io/?utm_term=a%zzb').utmTerm).toBe('a%zzb');
    expect(parseUrlParams('https://x.io/lp#utm_source=google&gclid=Cj0')).toMatchObject({ utmSource: 'google', gclid: 'Cj0' });
    expect(parseUrlParams('https://x.io/?UTM_Campaign=Upper&utm_campaign=second').utmCampaign).toBe('Upper');
    expect(parseUrlParams('https://x.io/?utm_campaign=&utm_source=+').utmCampaign).toBeNull();
    expect(parseUrlParams(null).utmCampaign).toBeNull();
    expect(clickIdsFromUrl('https://x.io/?fbclid=%E0%A4%A')).toEqual({ fbclid: '%E0%A4%A', gclid: null }); // no longer throws
  });

  it("fillFromUrl: GHL's structured fields win, only empty ones are filled, and it says which", () => {
    const r = fillFromUrl({ utmSource: 'Facebook Ads', utmCampaign: '   ' }, PROD_URL);
    expect(r.values.utmSource).toBe('Facebook Ads');
    expect(r.values.utmCampaign).toBe('(July 16) New VSL Landing Page / Doctor Job');
    expect(r.filled.sort()).toEqual(['fbclid', 'utmCampaign', 'utmContent', 'utmMedium']);
  });
});

describe('first-run utm backfill', () => {
  const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
  beforeAll(async () => {
    await runMigrations();
    await db.insert(contacts).values([
      { ghlContactId: 'url-only', attributionUrl: PROD_URL, attributionClass: 'organic', attributionReason: 'no paid signal', ...prov },
      { ghlContactId: 'structured', attributionUrl: PROD_URL, utmCampaign: 'Kept From GHL', ...prov },
      { ghlContactId: 'manual', attributionUrl: PROD_URL, attributionClass: 'organic', attributionReason: 'owner said so', attributionClassSource: 'manual', ...prov },
      { ghlContactId: 'demo', attributionUrl: PROD_URL, origin: 'demo', source: 'demo', backfilled: false },
    ]);
  });
  const row = async (id: string) => (await db.select().from(contacts).where(eq(contacts.ghlContactId, id)))[0];

  it('fills every existing contact once, reclassifies (manual overrides kept), leaves demo rows, then reports done', async () => {
    const r = await runUtmBackfill();
    expect(r).toMatchObject({ ok: true, scanned: 3, filledContacts: 3 });
    expect(await row('url-only')).toMatchObject({ utmCampaign: '(July 16) New VSL Landing Page / Doctor Job', utmSource: 'facebook', fbclid: 'IwAR0abc', attributionClass: 'paid' });
    expect((await row('structured')).utmCampaign).toBe('Kept From GHL');
    expect(await row('manual')).toMatchObject({ utmCampaign: '(July 16) New VSL Landing Page / Doctor Job', attributionClass: 'organic', attributionClassSource: 'manual' });
    expect((await row('demo')).utmCampaign).toBeNull();
    const again = await runUtmBackfill();
    expect(again.skipped).toMatch(/utm backfill v1 already done .* \(3 contacts filled\)/);
  });
});
