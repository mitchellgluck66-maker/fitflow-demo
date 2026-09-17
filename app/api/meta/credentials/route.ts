import { NextRequest, NextResponse } from 'next/server';
import { desc, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { setSetting, getSetting, SETTING_KEYS } from '@/lib/settings';
import { getMetaConfig, maskToken, META_KEYS } from '@/lib/meta/config';
import { testConnection } from '@/lib/meta/client';

export const dynamic = 'force-dynamic';

async function lastSync() {
  const [row] = await db
    .select()
    .from(syncRuns)
    .where(inArray(syncRuns.kind, ['meta_delta', 'meta_backfill']))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row
    ? { kind: row.kind, status: row.status, startedAt: row.startedAt.toISOString(), stats: row.stats, error: row.error, requestsUsed: row.requestsUsed }
    : null;
}

/** GET — connection state, token masked, never returned in full. */
export async function GET() {
  try {
    const config = await getMetaConfig();
    return NextResponse.json({
      configured: config.configured,
      source: config.source,
      tokenPreview: maskToken(config.token),
      adAccountId: config.adAccountId,
      hasToken: Boolean(config.token),
      hasAdAccountId: Boolean(config.adAccountId),
      lastSync: await lastSync(),
      backfillFrom: await getSetting(SETTING_KEYS.metaBackfillFrom),
      readOnly: true,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read Meta credentials', detail: String(error) }, { status: 500 });
  }
}

/** POST {token?, adAccountId?} — save, then verify with one request. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.token === 'string' && body.token.trim()) {
      await setSetting(META_KEYS.token, body.token.trim(), { secret: true });
    }
    if (typeof body.adAccountId === 'string') {
      await setSetting(META_KEYS.adAccountId, body.adAccountId.trim());
    }
    const config = await getMetaConfig();
    const verification = config.configured
      ? await testConnection()
      : { ok: false, configured: false, message: 'Both an access token and an ad account id are required.' };
    return NextResponse.json({
      ok: verification.ok,
      verification: {
        ok: verification.ok,
        message: verification.message,
        accountName: verification.account?.name ?? null,
        currency: verification.account?.currency ?? null,
      },
      configured: config.configured,
      source: config.source,
      tokenPreview: maskToken(config.token),
      adAccountId: config.adAccountId,
    });
  } catch (error) {
    console.error('Failed to save Meta credentials');
    return NextResponse.json({ error: 'Failed to save Meta credentials', detail: String(error) }, { status: 500 });
  }
}

/** DELETE — forget stored credentials (env vars, if any, remain). */
export async function DELETE() {
  try {
    await setSetting(META_KEYS.token, '', { secret: true });
    await setSetting(META_KEYS.adAccountId, '');
    const config = await getMetaConfig();
    return NextResponse.json({
      ok: true,
      message: config.source === 'env' ? 'Stored credentials cleared. Falling back to env vars.' : 'Stored credentials cleared.',
      configured: config.configured,
      source: config.source,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear Meta credentials', detail: String(error) }, { status: 500 });
  }
}
