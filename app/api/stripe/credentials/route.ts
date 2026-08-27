import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, or } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { setSetting } from '@/lib/settings';
import { getStripeConfig, maskToken, STRIPE_KEYS, REQUIRED_STRIPE_PERMISSIONS, isPlausibleStripeKey } from '@/lib/stripe/config';
import { testConnection } from '@/lib/stripe/client';

export const dynamic = 'force-dynamic';

async function lastRun() {
  const [run] = await db
    .select()
    .from(syncRuns)
    .where(or(eq(syncRuns.kind, 'stripe_reconcile'), eq(syncRuns.kind, 'stripe_backfill')))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return run ? { ...run, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, since: run.since?.toISOString() ?? null } : null;
}

/** GET — masked connection state. The key is never returned. */
export async function GET() {
  try {
    const config = await getStripeConfig();
    return NextResponse.json({
      configured: config.configured,
      source: config.source,
      keyPreview: maskToken(config.secretKey),
      keyKind: config.keyKind,
      hasWebhookSecret: config.hasWebhookSecret,
      webhookPreview: maskToken(config.webhookSecret),
      requiredPermissions: REQUIRED_STRIPE_PERMISSIONS,
      lastRun: await lastRun(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read Stripe credentials', detail: String(error) }, { status: 500 });
  }
}

/** POST {secretKey?, webhookSecret?} — save, then verify with one read. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.secretKey === 'string' && body.secretKey.trim()) {
      const key = body.secretKey.trim();
      if (!isPlausibleStripeKey(key)) {
        return NextResponse.json({ ok: false, verification: { ok: false, message: 'That does not look like a Stripe key (expected rk_live_… or rk_test_…).' } }, { status: 400 });
      }
      await setSetting(STRIPE_KEYS.secretKey, key, { secret: true });
    }
    if (typeof body.webhookSecret === 'string' && body.webhookSecret.trim()) {
      await setSetting(STRIPE_KEYS.webhookSecret, body.webhookSecret.trim(), { secret: true });
    }

    const config = await getStripeConfig();
    const verification = config.configured ? await testConnection() : { ok: false, configured: false, message: 'A Stripe restricted key is required.' };
    return NextResponse.json({
      ok: verification.ok,
      verification,
      configured: config.configured,
      source: config.source,
      keyPreview: maskToken(config.secretKey),
      keyKind: config.keyKind,
      hasWebhookSecret: config.hasWebhookSecret,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save Stripe credentials', detail: String(error) }, { status: 500 });
  }
}

/** DELETE — forget stored key + webhook secret. Env vars, if set, remain. */
export async function DELETE() {
  try {
    await setSetting(STRIPE_KEYS.secretKey, '', { secret: true });
    await setSetting(STRIPE_KEYS.webhookSecret, '', { secret: true });
    const config = await getStripeConfig();
    return NextResponse.json({ ok: true, configured: config.configured, source: config.source, message: 'Stored Stripe credentials cleared.' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear Stripe credentials', detail: String(error) }, { status: 500 });
  }
}
