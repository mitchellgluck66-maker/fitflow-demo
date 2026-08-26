import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, adSpend } from '@/db';
import { GET, POST, DELETE } from '@/app/api/spend/route';

const post = (body: unknown) =>
  POST(new NextRequest('http://x/api/spend', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

beforeAll(async () => {
  await runMigrations();
});

describe('manual weekly spend', () => {
  it('normalises any date to the Sunday of its Sun–Sat week', async () => {
    const res = await post({ weekOf: '2026-08-18', platform: 'meta', amountDollars: 1234.56 }); // Tuesday
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.week.start).toBe('2026-08-16');
    expect(data.week.label).toBe('Aug 16–22');
    const rows = await db.select().from(adSpend).where(eq(adSpend.externalId, 'manual:meta:2026-08-16'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-08-16', spendCents: 123456, origin: 'manual', source: 'manual', enteredBy: 'setup' });
  });

  it('upserting twice keeps one row with the latest amount', async () => {
    await post({ weekOf: '2026-08-20', platform: 'meta', amountDollars: 2000 });
    const rows = await db.select().from(adSpend).where(eq(adSpend.externalId, 'manual:meta:2026-08-16'));
    expect(rows).toHaveLength(1);
    expect(rows[0].spendCents).toBe(200000);
  });

  it('amount 0 deletes the manual row; DELETE does too', async () => {
    await post({ weekOf: '2026-08-16', platform: 'meta', amountDollars: 0 });
    expect(await db.select().from(adSpend).where(eq(adSpend.externalId, 'manual:meta:2026-08-16'))).toHaveLength(0);

    await post({ weekOf: '2026-08-16', platform: 'google', amountDollars: 10 });
    await DELETE(new NextRequest('http://x/api/spend?externalId=manual:google:2026-08-16', { method: 'DELETE' }));
    expect(await db.select().from(adSpend).where(eq(adSpend.externalId, 'manual:google:2026-08-16'))).toHaveLength(0);
  });

  it('never modifies API-origin rows, and replaces demo rows', async () => {
    await db.insert(adSpend).values({
      platform: 'meta', externalId: 'meta:camp1:2026-08-10', date: '2026-08-10', spendCents: 99900, source: 'meta', origin: 'meta',
    });
    await db.insert(adSpend).values({
      platform: 'google', externalId: 'manual:google:2026-08-09', date: '2026-08-09', spendCents: 500, source: 'demo', origin: 'demo',
    });
    await post({ weekOf: '2026-08-11', platform: 'meta', amountDollars: 1 });
    await post({ weekOf: '2026-08-11', platform: 'google', amountDollars: 7 });
    const api = await db.select().from(adSpend).where(eq(adSpend.externalId, 'meta:camp1:2026-08-10'));
    expect(api[0].spendCents).toBe(99900);
    const google = await db.select().from(adSpend).where(eq(adSpend.platform, 'google'));
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ origin: 'manual', spendCents: 700 });
    const bad = await DELETE(new NextRequest('http://x/api/spend?externalId=meta:camp1:2026-08-10', { method: 'DELETE' }));
    expect(bad.status).toBe(400);
  });

  it('GET groups rows by week, newest first', async () => {
    const res = await GET(new NextRequest('http://x/api/spend?weeks=60'));
    const data = await res.json();
    expect(data.platforms).toEqual(['meta', 'google', 'other']);
    expect(data.weeks.length).toBe(52);
    expect(data.weeks[0].start > data.weeks[1].start).toBe(true);
    const wk = data.weeks.find((w: { start: string }) => w.start === '2026-08-09');
    expect(wk.rows.map((r: { platform: string; origin: string }) => [r.platform, r.origin]).sort()).toEqual([['google', 'manual'], ['meta', 'manual'], ['meta', 'meta']]);
    expect(wk.totalCents).toBe(99900 + 100 + 700);
  });

  it('rejects bad input', async () => {
    expect((await post({ weekOf: 'nope', platform: 'meta', amountDollars: 1 })).status).toBe(400);
    expect((await post({ weekOf: '2026-08-16', platform: 'tiktok', amountDollars: 1 })).status).toBe(400);
    expect((await post({ weekOf: '2026-08-16', platform: 'meta', amountDollars: -1 })).status).toBe(400);
  });
});
