import { NextRequest, NextResponse } from 'next/server';
import { desc, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { setSetting } from '@/lib/settings';
import { getGoogleAdsConfig, maskToken, GOOGLE_ADS_KEYS, SECRET_FIELDS } from '@/lib/googleads/config';
import { testConnection } from '@/lib/googleads/client';

export const dynamic = 'force-dynamic';

async function lastSync() {
  const [row] = await db
    .select()
    .from(syncRuns)
    .where(inArray(syncRuns.kind, ['google_delta', 'google_backfill']))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row ? { kind: row.kind, status: row.status, startedAt: row.startedAt.toISOString(), stats: row.stats, error: row.error, requestsUsed: row.requestsUsed } : null;
}

async function state() {
  const c = await getGoogleAdsConfig();
  return {
    configured: c.configured,
    pending: c.pending,
    source: c.source,
    present: c.present,
    developerTokenPreview: maskToken(c.developerToken),
    clientId: c.clientId,
    clientSecretPreview: maskToken(c.clientSecret),
    refreshTokenPreview: maskToken(c.refreshToken),
    customerId: c.customerId,
    loginCustomerId: c.loginCustomerId,
    lastSync: await lastSync(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await state());
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read Google Ads credentials', detail: String(error) }, { status: 500 });
  }
}

const FIELD_TO_KEY: Record<string, string> = {
  developerToken: GOOGLE_ADS_KEYS.developerToken,
  clientId: GOOGLE_ADS_KEYS.clientId,
  clientSecret: GOOGLE_ADS_KEYS.clientSecret,
  refreshToken: GOOGLE_ADS_KEYS.refreshToken,
  customerId: GOOGLE_ADS_KEYS.customerId,
  loginCustomerId: GOOGLE_ADS_KEYS.loginCustomerId,
};

/** POST — partial saves are fine (Google grants pieces over time); verify only when complete. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
      const v = body[field];
      if (typeof v !== 'string') continue;
      const secret = SECRET_FIELDS.has(key);
      // Blank secret means "keep"; blank non-secret means "clear".
      if (secret && !v.trim()) continue;
      await setSetting(key, v.trim(), { secret });
    }
    const s = await state();
    const verification = s.configured
      ? await testConnection()
      : { ok: false, configured: false, pending: s.pending, message: s.pending ? 'Saved. Waiting on the remaining fields from Google.' : 'Saved.' };
    return NextResponse.json({ ok: verification.ok, verification, ...s });
  } catch (error) {
    console.error('Failed to save Google Ads credentials');
    return NextResponse.json({ error: 'Failed to save Google Ads credentials', detail: String(error) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    for (const key of Object.values(GOOGLE_ADS_KEYS)) await setSetting(key, '', { secret: SECRET_FIELDS.has(key) });
    return NextResponse.json({ ok: true, message: 'Stored Google Ads credentials cleared.', ...(await state()) });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear credentials', detail: String(error) }, { status: 500 });
  }
}
