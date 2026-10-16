import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { savePreferences, UserInputError } from '@/lib/auth/users';
import { timezoneOptions, validatePreferences } from '@/lib/companion/preferences';
import { mirrorCalendarsFor } from '@/lib/companion/mirror';
import { calendarLabel } from '@/lib/companion/calendars';
import { listCalendars } from '@/lib/ghl/client';
import { getTimezone } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/companion/settings — the signed-in user's preferences, the calendar list (live from GoHighLevel, else
 * the mirror's calendars for this user with the reason) and the timezone options.
 * The team-password owner has no row: `hasRow: false` and the page says preferences need a personal login.
 */
export async function GET() {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const businessTimezone = await getTimezone().catch(() => null);
    const live = await listCalendars().catch((e: unknown) => ({ ok: false as const, data: null, error: e instanceof Error ? e.message : String(e) }));
    let calendars: Array<{ id: string; name: string; active: boolean }> = [];
    let calendarsSource: 'live' | 'mirror' | 'none' = 'none';
    let calendarsError: string | null = null;
    if (live.ok && live.data) {
      calendars = live.data.calendars.map((c) => ({ id: c.id, name: calendarLabel(c.name, c.id), active: c.isActive !== false }));
      calendarsSource = 'live';
    } else {
      calendarsError = live.error ?? 'GoHighLevel calendars could not be read';
      if (me.user.ghlUserId) {
        calendars = (await dbTimeout(mirrorCalendarsFor(me.user.ghlUserId), 'companion calendars')).map((c) => ({ ...c, active: true }));
        if (calendars.length > 0) calendarsSource = 'mirror';
      }
    }
    return NextResponse.json({
      hasRow: me.user.source === 'db',
      user: { id: me.user.uid, name: me.user.name, email: me.user.email, role: me.user.role, ghlUserId: me.user.ghlUserId },
      preferences: { calendarIds: me.user.preferences.calendarIds ?? null, timezone: me.user.preferences.timezone ?? null, autoAdvance: me.user.preferences.autoAdvance ?? true },
      businessTimezone,
      timezones: timezoneOptions(businessTimezone ?? 'UTC'),
      calendars,
      calendarsSource,
      calendarsError,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the Companion settings');
  }
}

/** PATCH /api/companion/settings { calendarIds?, timezone?, autoAdvance? } — saved on the user's row. */
export async function PATCH(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  if (me.user.source !== 'db') return NextResponse.json({ error: 'Sign in with a personal login to save preferences', detail: 'The team password has no user row to keep them on.' }, { status: 409 });
  try {
    const check = validatePreferences(await request.json().catch(() => null));
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    const preferences = await dbTimeout(savePreferences(me.user.uid, check.prefs), 'companion settings');
    return NextResponse.json({ ok: true, preferences: { calendarIds: preferences.calendarIds ?? null, timezone: preferences.timezone ?? null, autoAdvance: preferences.autoAdvance ?? true } });
  } catch (error) {
    if (error instanceof UserInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    return apiErrorResponse(error, 'Failed to save the preferences');
  }
}
