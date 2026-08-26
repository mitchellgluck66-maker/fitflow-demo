import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, setSetting, SETTING_KEYS } from '@/lib/settings';
import { getGhlConfig, REQUIRED_SCOPES } from '@/lib/ghl/config';
import { testConnection } from '@/lib/ghl/client';
import { getQueueStats } from '@/lib/ghl/sync';

export const dynamic = 'force-dynamic';

/**
 * Settings are persisted in the app_settings table rather than module state.
 * The previous in-memory version silently reset on every server restart, which
 * meant a saved timezone quietly reverted and nobody noticed until reports were
 * off by a few hours.
 */
export async function GET() {
  try {
    const [stored, connection, queue] = await Promise.all([
      getAllSettings(),
      testConnection(),
      getQueueStats(),
    ]);

    const config = await getGhlConfig();

    return NextResponse.json({
      timezone: stored[SETTING_KEYS.timezone] ?? 'America/New_York',
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
      lastAutoSyncAt: stored[SETTING_KEYS.lastAutoSyncAt] ?? null,
      ghlPipelineId: stored[SETTING_KEYS.ghlPipelineId] ?? '',

      ghl: {
        configured: config.configured,
        dryRun: config.dryRun,
        notifyOnWrite: config.notifyOnWrite,
        hasToken: Boolean(config.token),
        hasLocationId: Boolean(config.locationId),
        requiredScopes: REQUIRED_SCOPES,
        connection,
      },

      email: {
        configured: Boolean(process.env.RESEND_API_KEY?.trim()),
        from: process.env.RESEND_FROM_EMAIL ?? null,
      },

      queue,
    });
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch settings', detail: String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.timezone) {
      const valid = Intl.supportedValuesOf('timeZone');
      if (!valid.includes(body.timezone)) {
        return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 });
      }
      await setSetting(SETTING_KEYS.timezone, body.timezone);
    }

    if (typeof body.autoSyncEnabled === 'boolean') {
      await setSetting(
        SETTING_KEYS.autoSyncEnabled,
        body.autoSyncEnabled ? 'true' : 'false',
      );
    }

    if (typeof body.summaryRecipientEmail === 'string') {
      await setSetting(SETTING_KEYS.summaryRecipientEmail, body.summaryRecipientEmail);
    }

    if (typeof body.ghlPipelineId === 'string') {
      await setSetting(SETTING_KEYS.ghlPipelineId, body.ghlPipelineId);
    }

    const stored = await getAllSettings();

    return NextResponse.json({
      ok: true,
      timezone: stored[SETTING_KEYS.timezone],
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
    });
  } catch (error) {
    console.error('Failed to update settings:', error);
    return NextResponse.json(
      { error: 'Failed to update settings', detail: String(error) },
      { status: 500 },
    );
  }
}
