import { NextRequest, NextResponse } from 'next/server';
import { setSetting, getSetting } from '@/lib/settings';
import { getGhlConfig, maskToken, CREDENTIAL_KEYS, REQUIRED_SCOPES, ENABLE_WRITEBACK } from '@/lib/ghl/config';
import { testConnection } from '@/lib/ghl/client';

export const dynamic = 'force-dynamic';

async function followedCalendars(): Promise<string[]> {
  const raw = await getSetting(CREDENTIAL_KEYS.followedCalendars);
  try {
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/ghl/credentials — connection state. The token itself is NEVER
 * returned; only a masked tail so the UI can confirm which one is saved.
 */
export async function GET() {
  try {
    const config = await getGhlConfig();
    return NextResponse.json({
      configured: config.configured,
      source: config.source,
      tokenPreview: maskToken(config.token),
      locationId: config.locationId,
      hasToken: Boolean(config.token),
      hasLocationId: Boolean(config.locationId),
      followedCalendars: await followedCalendars(),
      requiredScopes: REQUIRED_SCOPES,
      readOnly: true,
      writebackEnabled: ENABLE_WRITEBACK,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read credentials', detail: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/ghl/credentials  Body: { token?, locationId?, followedCalendars? }
 * Saves, then verifies immediately with one read call.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body.token === 'string' && body.token.trim()) {
      await setSetting(CREDENTIAL_KEYS.token, body.token.trim(), { secret: true });
    }
    if (typeof body.locationId === 'string') {
      await setSetting(CREDENTIAL_KEYS.locationId, body.locationId.trim());
    }
    if (Array.isArray(body.followedCalendars)) {
      await setSetting(CREDENTIAL_KEYS.followedCalendars, JSON.stringify(body.followedCalendars));
    }

    const config = await getGhlConfig();
    const verification = config.configured
      ? await testConnection()
      : { ok: false, configured: false, message: 'Both a Private Integration Token and a Location ID are required.' };

    return NextResponse.json({
      ok: verification.ok,
      verification,
      configured: config.configured,
      source: config.source,
      tokenPreview: maskToken(config.token),
      locationId: config.locationId,
    });
  } catch (error) {
    console.error('Failed to save credentials');
    return NextResponse.json({ error: 'Failed to save credentials', detail: String(error) }, { status: 500 });
  }
}

/** DELETE — forget stored credentials. Env vars, if set, remain in effect. */
export async function DELETE() {
  try {
    await setSetting(CREDENTIAL_KEYS.token, '', { secret: true });
    await setSetting(CREDENTIAL_KEYS.locationId, '');
    const config = await getGhlConfig();
    return NextResponse.json({
      ok: true,
      message: config.source === 'env' ? 'Stored credentials cleared. Falling back to env vars.' : 'Stored credentials cleared.',
      configured: config.configured,
      source: config.source,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear credentials', detail: String(error) }, { status: 500 });
  }
}
