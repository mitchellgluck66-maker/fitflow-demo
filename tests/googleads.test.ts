import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, adSpend } from '@/db';
import { parseGoogleAdsCsv, csvExternalId } from '@/lib/googleads/csv';
import { runGoogleAdsSync, importGoogleAdsCsv } from '@/lib/googleads/ingest';
import { POST as csvPost } from '@/app/api/googleads/csv/route';

const EXPORT = `﻿Campaign report
Aug 2 - Aug 8, 2026
Day,Campaign,Campaign ID,Cost,Impr.,Clicks,Conversions
2026-08-03,"Brand, Search",123,"$1,234.56","12,345",456,3.00
2026-08-03,Retarget,456,$99.10,300,10,0.00
2026-08-04,"Brand, Search",123,$1000,10000,400,2.50
Total: account,,,"$2,333.66","22,645",866,5.50
`;

describe('parseGoogleAdsCsv', () => {
  it('parses the UI export: BOM, preamble, quoted commas, currency, totals', () => {
    const r = parseGoogleAdsCsv(EXPORT);
    expect(r.rows).toEqual([
      { date: '2026-08-03', campaignId: '123', campaignName: 'Brand, Search', spendCents: 123_456, impressions: 12_345, clicks: 456, conversions: 3 },
      { date: '2026-08-03', campaignId: '456', campaignName: 'Retarget', spendCents: 9_910, impressions: 300, clicks: 10, conversions: 0 },
      { date: '2026-08-04', campaignId: '123', campaignName: 'Brand, Search', spendCents: 100_000, impressions: 10_000, clicks: 400, conversions: 2.5 },
    ]);
    expect(r.skipped).toBe(1); // Total row
    expect(r.warnings[0]).toMatch(/2 preamble/);
    expect(csvExternalId(r.rows[0])).toBe('google_csv:123:2026-08-03');
  });

  it('accepts a header variant with Date / Impressions and US dates, no campaign id', () => {
    const r = parseGoogleAdsCsv('Date,Campaign,Impressions,Clicks,Cost\n8/5/2026,Summer,100,5,"$12.34"\n');
    expect(r.rows).toEqual([{ date: '2026-08-05', campaignId: null, campaignName: 'Summer', spendCents: 1_234, impressions: 100, clicks: 5, conversions: 0 }]);
    expect(csvExternalId(r.rows[0])).toBe('google_csv:summer:2026-08-05');
  });

  it('reports when no usable header exists', () => {
    const r = parseGoogleAdsCsv('foo,bar\n1,2\n');
    expect(r.rows).toEqual([]);
    expect(r.warnings[0]).toMatch(/header/);
  });
});

describe('import + sync', () => {
  const fetchSpy = vi.fn();
  beforeAll(async () => {
    await runMigrations();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterAll(() => vi.unstubAllGlobals());

  it('CSV import is idempotent and rows carry origin google_csv', async () => {
    const first = await importGoogleAdsCsv(EXPORT);
    expect(first).toMatchObject({ ok: true, imported: 3, spendCents: 233_366, days: 2, campaigns: 2, dateRange: { start: '2026-08-03', end: '2026-08-04' } });
    const again = await importGoogleAdsCsv(EXPORT);
    expect(again.imported).toBe(3);
    const rows = await db.select().from(adSpend).where(eq(adSpend.origin, 'google_csv'));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.platform === 'google' && r.level === 'campaign' && r.source === 'google_csv')).toBe(true);
  });

  it('the upload route accepts a raw csv body', async () => {
    const req = new NextRequest('http://localhost/api/googleads/csv', { method: 'POST', body: EXPORT, headers: { 'content-type': 'text/csv' } });
    const res = await csvPost(req);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.imported).toBe(3);
    expect((await db.select().from(adSpend).where(eq(adSpend.origin, 'google_csv'))).length).toBe(3);
  });

  it('unconfigured sync returns notConfigured without touching the network', async () => {
    fetchSpy.mockReset();
    const r = await runGoogleAdsSync({ mode: 'delta', trigger: 'cli' });
    expect(r).toMatchObject({ ok: false, notConfigured: true, runId: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
