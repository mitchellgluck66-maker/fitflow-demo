import { NextRequest, NextResponse } from 'next/server';
import { setSetting, getSetting } from '@/lib/settings';
import { getGhlConfig, maskToken, CREDENTIAL_KEYS, REQUIRED_SCOPES } from '@/lib/ghl/config';
import { listCalendars } from '@/lib/ghl/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ghl/credentials — current connection state.
 *
 * The token itself is NEVER returned, only a masked tail so the UI can confirm
 * which one is saved. Anything that echoes a secret back to the client is one
 * screenshot away from leaking it.
 */
export async function GET() {
  try {
    const config = await getGhlConfig();
    const followedRaw = await getSetting(CREDENTIAL_KEYS.followedCalendars);

    let followedCalendars: string[] = [];
    try {
      followedCalendars = followedRaw ? JSON.parse(followedRaw) : [];
    } catch {
      followedCalendars = [];
    }

    return NextResponse.json({
      configured: config.configured,
      dryRun: config.dryRun,
      notifyOnWrite: config.notifyOnWrite,
      source: config.source,
      tokenPreview: maskToken(config.token),
      locationId: config.locationId,
      hasToken: Boolean(config.token),
      hasLocationId: Boolean(config.locationId),
      followedCalendars,
      requiredScopes: REQUIRED_SCOPES,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read credentials', detail: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/ghl/credentials
 * Body: { token?, locationId?, dryRun?, notifyOnWrite?, followedCalendars? }
 *
 * Saves the Private Integration Token and location, then immediately verifies
 * them against the live API. Saving credentials that don't work is worse than
 * not saving them, because the failure surfaces later and somewhere confusing.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (typeof body.token === 'string' && body.token.trim()) {
      await setSetting(CREDENTIAL_KEYS.token, body.token.trim());
    }

    if (typeof body.locationId === 'string') {
      await setSetting(CREDENTIAL_KEYS.locationId, body.locationId.trim());
    }

    if (typeof body.dryRun === 'boolean') {
      await setSetting(CREDENTIAL_KEYS.dryRun, body.dryRun ? 'true' : 'false');
    }

    if (typeof body.notifyOnWrite === 'boolean') {
      await setSetting(
        CREDENTIAL_KEYS.notifyOnWrite,
        body.notifyOnWrite ? 'true' : 'false',
      );
    }

    if (Array.isArray(body.followedCalendars)) {
      await setSetting(
        CREDENTIAL_KEYS.followedCalendars,
        JSON.stringify(body.followedCalendars),
      );
    }

    // Verify straight away so the user finds out now, not at midnight.
    const config = await getGhlConfig();
    let verification: { ok: boolean; message: string; calendarCount?: number };

    if (!config.configured) {
      verification = {
        ok: false,
        message: 'Both a Private Integration Token and a Location ID are required.',
      };
    } else if (config.dryRun) {
      verification = {
        ok: true,
        message:
          'Credentials saved. Live mode is off, so nothing will be written to GoHighLevel yet.',
      };
    } else {
      const test = await listCalendars();
      verification = test.ok
        ? {
            ok: true,
            message: 'Connected. Credentials verified against your account.',
            calendarCount: test.data?.calendars?.length ?? 0,
          }
        : {
            ok: false,
            message:
              test.error ??
              'Could not reach GoHighLevel. Check the token has the required scopes and the Location ID is correct.',
          };
    }

    return NextResponse.json({
      ok: verification.ok,
      verification,
      configured: config.configured,
      dryRun: config.dryRun,
      source: config.source,
      tokenPreview: maskToken(config.token),
      locationId: config.locationId,
    });
  } catch (error) {
    console.error('Failed to save credentials:', error);
    return NextResponse.json(
      { error: 'Failed to save credentials', detail: String(error) },
      { status: 500 },
    );
  }
}

/** DELETE — forget stored credentials. Env vars, if set, remain in effect. */
export async function DELETE() {
  try {
    await setSetting(CREDENTIAL_KEYS.token, '');
    await setSetting(CREDENTIAL_KEYS.locationId, '');
    await setSetting(CREDENTIAL_KEYS.dryRun, 'true');

    const config = await getGhlConfig();

    return NextResponse.json({
      ok: true,
      message:
        config.source === 'env'
          ? 'Stored credentials cleared. Falling back to the values in .env.local.'
          : 'Stored credentials cleared.',
      configured: config.configured,
      source: config.source,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to clear credentials', detail: String(error) },
      { status: 500 },
    );
  }
}
