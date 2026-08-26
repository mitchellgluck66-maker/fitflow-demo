import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, setSetting, SETTING_KEYS } from '@/lib/settings';
import { getGhlConfig, REQUIRED_SCOPES, ENABLE_WRITEBACK } from '@/lib/ghl/config';
import { testConnection } from '@/lib/ghl/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [stored, connection, config] = await Promise.all([getAllSettings(), testConnection(), getGhlConfig()]);

    return NextResponse.json({
      timezone: stored[SETTING_KEYS.timezone] ?? 'America/New_York',
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
      digestRecipients: stored[SETTING_KEYS.digestRecipients] ?? '',
      lastAutoSyncAt: stored[SETTING_KEYS.ghlLastSyncAt] ?? null,
      backfillFrom: stored[SETTING_KEYS.backfillFrom] ?? '2026-06-16',
      ghl: {
        configured: config.configured,
        readOnly: true,
        writebackEnabled: ENABLE_WRITEBACK,
        dryRun: true,
        notifyOnWrite: false,
        hasToken: Boolean(config.token),
        hasLocationId: Boolean(config.locationId),
        requiredScopes: REQUIRED_SCOPES,
        connection: { ...connection, dryRun: false },
      },
      email: {
        configured: Boolean(process.env.RESEND_API_KEY?.trim()),
        from: process.env.RESEND_FROM_EMAIL ?? null,
      },
      queue: { pending: 0, failed: 0, succeeded: 0, dryRun: 0, isDryRun: false },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch settings', detail: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.timezone) {
      if (!Intl.supportedValuesOf('timeZone').includes(body.timezone)) {
        return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 });
      }
      await setSetting(SETTING_KEYS.timezone, body.timezone);
    }
    if (typeof body.autoSyncEnabled === 'boolean') {
      await setSetting(SETTING_KEYS.autoSyncEnabled, body.autoSyncEnabled ? 'true' : 'false');
    }
    if (typeof body.summaryRecipientEmail === 'string') {
      await setSetting(SETTING_KEYS.summaryRecipientEmail, body.summaryRecipientEmail);
    }
    if (typeof body.digestRecipients === 'string') {
      await setSetting(SETTING_KEYS.digestRecipients, body.digestRecipients);
    }
    if (typeof body.backfillFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.backfillFrom)) {
      await setSetting(SETTING_KEYS.backfillFrom, body.backfillFrom);
    }

    const stored = await getAllSettings();
    return NextResponse.json({
      ok: true,
      timezone: stored[SETTING_KEYS.timezone],
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
      digestRecipients: stored[SETTING_KEYS.digestRecipients] ?? '',
      backfillFrom: stored[SETTING_KEYS.backfillFrom],
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update settings', detail: String(error) }, { status: 500 });
  }
}
