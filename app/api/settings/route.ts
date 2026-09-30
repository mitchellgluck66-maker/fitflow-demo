import { NextRequest, NextResponse } from 'next/server';
import { dbTimeout, apiErrorResponse } from '@/lib/dbTimeout';
import { getAllSettings, setSetting, SETTING_KEYS, getTimezone } from '@/lib/settings';
import { getGhlConfig, REQUIRED_SCOPES, ENABLE_WRITEBACK } from '@/lib/ghl/config';
import { testConnection } from '@/lib/ghl/client';
import { keyStatus, keyStatusMessage } from '@/lib/crypto/credentials';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [stored, connection, config] = await dbTimeout(Promise.all([getAllSettings(), testConnection(), getGhlConfig()]), 'settings');
    // F8: the resolved business timezone, or null + the reason — never a silent America/New_York.
    const tz = await getTimezone().then((timezone) => ({ timezone, error: null as string | null })).catch((e: unknown) => ({ timezone: null, error: e instanceof Error ? e.message : String(e) }));

    return NextResponse.json({
      timezone: tz.timezone,
      timezoneError: tz.error,
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
      digestRecipients: stored[SETTING_KEYS.digestRecipients] ?? '',
      digestRecipientsTodo: stored[SETTING_KEYS.digestRecipientsTodo] ?? '',
      digestRecipientsWeekly: stored[SETTING_KEYS.digestRecipientsWeekly] ?? '',
      digestRecipientsMonthly: stored[SETTING_KEYS.digestRecipientsMonthly] ?? '',
      digestEnabledTodo: stored[SETTING_KEYS.digestEnabledTodo] !== 'false',
      digestEnabledWeekly: stored[SETTING_KEYS.digestEnabledWeekly] !== 'false',
      digestEnabledMonthly: stored[SETTING_KEYS.digestEnabledMonthly] !== 'false',
      lastAutoSyncAt: stored[SETTING_KEYS.ghlLastSyncAt] ?? null,
      backfillFrom: stored[SETTING_KEYS.backfillFrom] ?? '2026-06-01',
      metaBackfillFrom: stored[SETTING_KEYS.metaBackfillFrom] ?? '2026-07-16',
      historyCompleteSince: stored[SETTING_KEYS.historyCompleteSince],
      disclaimerSunset: stored[SETTING_KEYS.disclaimerSunset],
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
      // H4: encryption-at-rest status (mode + one sentence; never key material).
      credentials: (() => {
        const s = keyStatus();
        return { mode: s.mode, message: keyStatusMessage(s) };
      })(),
      email: {
        configured: Boolean(process.env.RESEND_API_KEY?.trim()),
        from: process.env.RESEND_FROM_EMAIL ?? null,
      },
      queue: { pending: 0, failed: 0, succeeded: 0, dryRun: 0, isDryRun: false },
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to fetch settings');
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
    for (const [field, key] of [
      ['digestRecipientsTodo', SETTING_KEYS.digestRecipientsTodo],
      ['digestRecipientsWeekly', SETTING_KEYS.digestRecipientsWeekly],
      ['digestRecipientsMonthly', SETTING_KEYS.digestRecipientsMonthly],
    ] as const) {
      if (typeof body[field] === 'string') await setSetting(key, body[field]);
    }
    if (typeof body.backfillFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.backfillFrom)) {
      await setSetting(SETTING_KEYS.backfillFrom, body.backfillFrom);
    }
    for (const [field, key] of [
      ['historyCompleteSince', SETTING_KEYS.historyCompleteSince],
      ['disclaimerSunset', SETTING_KEYS.disclaimerSunset],
    ] as const) {
      if (typeof body[field] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body[field])) await setSetting(key, body[field]);
    }
    if (typeof body.metaBackfillFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.metaBackfillFrom)) {
      await setSetting(SETTING_KEYS.metaBackfillFrom, body.metaBackfillFrom);
      // A new window invalidates any partial-backfill cursor.
      await setSetting(SETTING_KEYS.metaBackfillCursor, '');
    }

    for (const [field, key] of [
      ['digestEnabledTodo', SETTING_KEYS.digestEnabledTodo],
      ['digestEnabledWeekly', SETTING_KEYS.digestEnabledWeekly],
      ['digestEnabledMonthly', SETTING_KEYS.digestEnabledMonthly],
    ] as const) {
      if (typeof body[field] === 'boolean') await setSetting(key, body[field] ? 'true' : 'false');
    }

    const stored = await getAllSettings();
    return NextResponse.json({
      ok: true,
      digestEnabledTodo: stored[SETTING_KEYS.digestEnabledTodo] !== 'false',
      digestEnabledWeekly: stored[SETTING_KEYS.digestEnabledWeekly] !== 'false',
      digestEnabledMonthly: stored[SETTING_KEYS.digestEnabledMonthly] !== 'false',
      timezone: stored[SETTING_KEYS.timezone],
      autoSyncEnabled: stored[SETTING_KEYS.autoSyncEnabled] !== 'false',
      summaryRecipientEmail: stored[SETTING_KEYS.summaryRecipientEmail] ?? '',
      digestRecipients: stored[SETTING_KEYS.digestRecipients] ?? '',
      digestRecipientsTodo: stored[SETTING_KEYS.digestRecipientsTodo] ?? '',
      digestRecipientsWeekly: stored[SETTING_KEYS.digestRecipientsWeekly] ?? '',
      digestRecipientsMonthly: stored[SETTING_KEYS.digestRecipientsMonthly] ?? '',
      backfillFrom: stored[SETTING_KEYS.backfillFrom],
      metaBackfillFrom: stored[SETTING_KEYS.metaBackfillFrom],
      historyCompleteSince: stored[SETTING_KEYS.historyCompleteSince],
      disclaimerSunset: stored[SETTING_KEYS.disclaimerSunset],
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update settings', detail: String(error) }, { status: 500 });
  }
}
