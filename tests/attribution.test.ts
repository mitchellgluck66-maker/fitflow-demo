/**
 * Paid vs organic attribution (Phase G item 2): pure classifier + DB runner
 * + manual override persistence.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { classifyAttribution, clickIdsFromUrl, isPaidValue, PAID_TOKENS } from '@/lib/attribution/classify';
import { runAttributionClassification, setAttributionOverride } from '@/lib/attribution/run';
import { runMigrations } from '@/db/migrate';
import { db, contacts } from '@/db';

describe('classifyAttribution (pure)', () => {
  it('fbclid / gclid win outright, with the reason naming the click id', () => {
    expect(classifyAttribution({ fbclid: 'IwAR123', utmSource: 'newsletter' })).toEqual({ attributionClass: 'paid', reason: 'fbclid present (Meta click id)' });
    expect(classifyAttribution({ gclid: 'Cj0K', source: 'Referral' })).toEqual({ attributionClass: 'paid', reason: 'gclid present (Google click id)' });
  });

  it('finds click ids inside the landing URL', () => {
    expect(clickIdsFromUrl('https://fit.example/apply?utm_source=x&fbclid=ABC%20d#top')).toEqual({ fbclid: 'ABC d', gclid: null });
    expect(clickIdsFromUrl('https://fit.example/apply?gclid=G1&x=2')).toEqual({ fbclid: null, gclid: 'G1' });
    expect(clickIdsFromUrl('https://fit.example/apply')).toEqual({ fbclid: null, gclid: null });
    expect(classifyAttribution({ url: 'https://fit.example/apply?fbclid=Z' })).toMatchObject({ attributionClass: 'paid', reason: 'fbclid present (Meta click id, from landing URL)' });
  });

  it('paid patterns on utm_source, then source, then utm_medium, then session source', () => {
    for (const v of ['facebook', 'FB', 'Meta Ads', 'instagram', 'google', 'paid_social', 'cpc', 'ppc']) {
      expect(classifyAttribution({ utmSource: v }).attributionClass, v).toBe('paid');
    }
    expect(classifyAttribution({ utmSource: 'fb' }).reason).toBe('utm_source "fb" matches a paid pattern');
    expect(classifyAttribution({ source: 'Facebook Ad — VSL' })).toMatchObject({ attributionClass: 'paid', reason: 'source "Facebook Ad — VSL" matches a paid pattern' });
    expect(classifyAttribution({ utmMedium: 'cpc' })).toMatchObject({ attributionClass: 'paid', reason: 'utm_medium "cpc" matches a paid pattern' });
    expect(classifyAttribution({ sessionSource: 'Paid Social' })).toMatchObject({ attributionClass: 'paid', reason: 'session source "Paid Social" matches a paid pattern' });
  });

  it('organic when nothing paid is present, and the reason lists what was checked', () => {
    expect(classifyAttribution({ source: 'Referral', utmMedium: 'referral' })).toEqual({
      attributionClass: 'organic',
      reason: 'no paid signal — no click id; source "Referral", utm_medium "referral"',
    });
    expect(classifyAttribution({})).toEqual({ attributionClass: 'organic', reason: 'no paid signal — no click id, no utm_source, no source' });
    expect(classifyAttribution({ utmSource: '  ', source: '' }).attributionClass).toBe('organic');
  });

  it('"organic" in the same value overrides a paid token — Google Organic is not an ad', () => {
    expect(isPaidValue('google organic')).toBe(false);
    expect(isPaidValue('Organic Search')).toBe(false);
    expect(classifyAttribution({ utmSource: 'google', utmMedium: 'organic' }).attributionClass).toBe('paid'); // utm_source alone says google
    expect(classifyAttribution({ utmSource: 'google organic' }).attributionClass).toBe('organic');
  });

  it('matches whole tokens only (no "fb" inside "fbclid"-like words, no "meta" inside "metabolic")', () => {
    expect(isPaidValue('metabolic reset webinar')).toBe(false);
    expect(isPaidValue('fbook')).toBe(false);
    expect(isPaidValue('Website')).toBe(false);
    expect(PAID_TOKENS).toContain('facebook');
  });
});

describe('runAttributionClassification + override (DB)', () => {
  let paidId: string;
  let refId: string;

  beforeAll(async () => {
    await runMigrations();
    const rows = await db
      .insert(contacts)
      .values([
        { ghlContactId: 'att-paid', firstName: 'Pia', utmSource: 'facebook', attributionSource: 'Facebook Ad', source: 'ghl', origin: 'ghl' },
        { ghlContactId: 'att-ref', firstName: 'Ref', attributionSource: 'Referral', source: 'ghl', origin: 'ghl' },
        { ghlContactId: 'att-url', firstName: 'Url', attributionUrl: 'https://x.example/?gclid=abc', source: 'ghl', origin: 'ghl' },
      ])
      .returning({ id: contacts.id, ghl: contacts.ghlContactId });
    paidId = rows.find((r) => r.ghl === 'att-paid')!.id;
    refId = rows.find((r) => r.ghl === 'att-ref')!.id;
  });

  const classOf = async (id: string) => {
    const [r] = await db.select({ c: contacts.attributionClass, src: contacts.attributionClassSource, why: contacts.attributionReason }).from(contacts).where(eq(contacts.id, id));
    return r;
  };

  it('classifies every contact, idempotently', async () => {
    const first = await runAttributionClassification();
    expect(first).toMatchObject({ scanned: 3, paid: 2, organic: 1, manual: 0, updated: 3 });
    expect(await classOf(paidId)).toMatchObject({ c: 'paid', src: 'auto' });
    expect(await classOf(refId)).toMatchObject({ c: 'organic', src: 'auto' });
    expect((await runAttributionClassification()).updated).toBe(0);
  });

  it('a manual override persists across reclassification and clears back to auto', async () => {
    const set = await setAttributionOverride(refId, 'paid', 'Miranda confirmed they came from the VSL ad');
    expect(set).toMatchObject({ ok: true, attributionClass: 'paid', source: 'manual' });
    expect(set.reason).toContain('manual override: Miranda confirmed');
    expect(set.reason).toContain('auto would say organic');

    const run = await runAttributionClassification();
    expect(run).toMatchObject({ manual: 1, updated: 0 });
    expect(await classOf(refId)).toMatchObject({ c: 'paid', src: 'manual' });

    const cleared = await setAttributionOverride(refId, null);
    expect(cleared).toMatchObject({ ok: true, attributionClass: 'organic', source: 'auto' });
    expect(await classOf(refId)).toMatchObject({ c: 'organic', src: 'auto' });
  });

  it('unknown contact is reported, not thrown', async () => {
    expect(await setAttributionOverride('nope', 'paid')).toMatchObject({ ok: false });
  });
});
