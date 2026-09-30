import { NextRequest, NextResponse } from 'next/server';
import { desc, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { setSetting, getSetting, SETTING_KEYS } from '@/lib/settings';
import { getMetaConfig, maskToken, META_KEYS } from '@/lib/meta/config';
import { testConnection } from '@/lib/meta/client';
import { CredentialsKeyError } from '@/lib/crypto/credentials';

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
    // F13: persist the account as Meta states it (the next sync re-reads and relabels against the same values).
    const acct = 'account' in verification ? verification.account : undefined;
    if (verification.ok && acct?.currency) {
      await setSetting(SETTING_KEYS.metaAccount, JSON.stringify({ id: acct.id, name: acct.name ?? null, currency: acct.currency.toUpperCase(), timezone: acct.timezone_name ?? null, checkedAt: new Date().toISOString() }));
    }
    return NextResponse.json({
      ok: verification.ok,
      verification: {
        ok: verification.ok,
        message: verification.message,
        accountName: acct?.name ?? null,
        currency: acct?.currency?.toUpperCase() ?? null,
        timezone: acct?.timezone_name ?? null,
      },
      configured: config.configured,
      source: config.source,
      tokenPreview: maskToken(config.token),
      adAccountId: config.adAccountId,
    });
  } catch (error) {
    console.error('Failed to save Meta credentials');
    // H4: no usable CREDENTIALS_KEY in production → refuse to store plaintext, say why.
    if (error instanceof CredentialsKeyError) return NextResponse.json({ error: error.message, locked: true }, { status: 503 });
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
