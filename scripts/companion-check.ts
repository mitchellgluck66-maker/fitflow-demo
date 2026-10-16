/**
 * Companion stage 1 — live proof for "My day" (read-only, GHL through ghlRequest only).
 *
 *   npm run companion:check                       # the one active onboarding user with a GHL user
 *   npm run companion:check -- --user miranda@…   # by login email
 *   npm run companion:check -- --ghl-user gUYW…   # by GHL user id (works before the app_users migration)
 *   npm run companion:check -- --days 5 --date 2026-10-16
 *
 * For the last 5 working days (Mon–Fri up to today, in the user's timezone) it compares, per day:
 *   A  the Companion's day — lib/companion/source#loadDayRaw, the live path, the user's calendar filter, no cache
 *   B  an INDEPENDENT walk — every active GHL calendar, ONE 7-day window per calendar, events kept when their start
 *      falls on the local date and assignedUserId / users[] names the user (no filter, no day-bounds helper)
 *   M  the mirror (our synced appointments) — INFO only; sync lag is expected, not a failure
 * Prints the three counts per day and every event on one side but not the other. A = B on every day → PASS (exit 0);
 * any difference, or a day the Companion could only answer from the mirror → FAIL (exit 1).
 */
import { eq, sql } from 'drizzle-orm';
import { db, appUsers } from '../db';
import { getTimezone, isValidTimezone } from '../lib/settings';
import { todayInTimezone, addDays, getDayBounds, formatTime } from '../lib/day';
import { listAppointments, listCalendars } from '../lib/ghl/client';
import { isAssignedTo } from '../lib/companion/calendars';
import { loadDayRaw } from '../lib/companion/source';
import { liveGhl } from '../lib/companion/service';
import { readMirrorDay } from '../lib/companion/mirror';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function workingDays(endDate: string, count: number, tz: string): string[] {
  const out: string[] = [];
  let d = endDate;
  while (out.length < count) {
    const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${d}T12:00:00Z`));
    if (dow !== 'Sat' && dow !== 'Sun') out.push(d);
    d = addDays(d, -1);
  }
  void tz;
  return out.reverse();
}

async function resolveUser(): Promise<{ ghlUserId: string; label: string; calendarFilter: string[] | null; timezone: string | null }> {
  const ghlArg = arg('ghl-user');
  const email = arg('user');
  if (ghlArg && !email) return { ghlUserId: ghlArg, label: `GHL user ${ghlArg}`, calendarFilter: null, timezone: null };
  let rows: Array<typeof appUsers.$inferSelect> = [];
  try {
    rows = email
      ? await db.select().from(appUsers).where(eq(sql`lower(${appUsers.email})`, email.toLowerCase()))
      : await db.select().from(appUsers).where(eq(appUsers.active, true));
  } catch (err) {
    throw new Error(`app_users could not be read (${err instanceof Error ? err.message : String(err)}) — run npm run db:migrate, or pass --ghl-user <id>`);
  }
  const candidates = rows.filter((r) => r.active && r.ghlUserId && (email || r.role === 'onboarding'));
  if (candidates.length !== 1) throw new Error(email ? `no active login with a GHL user for ${email}` : `${candidates.length} active onboarding logins with a GHL user — pass --user <email> or --ghl-user <id>`);
  const u = candidates[0];
  return { ghlUserId: u.ghlUserId!, label: `${u.name} <${u.email}> · GHL user ${u.ghlUserId}`, calendarFilter: u.preferences?.calendarIds?.length ? u.preferences.calendarIds : null, timezone: u.preferences?.timezone ?? null };
}

async function main() {
  const user = await resolveUser();
  const tz = user.timezone && isValidTimezone(user.timezone) ? user.timezone : await getTimezone();
  const days = Number(arg('days') ?? 5);
  const end = arg('date') ?? todayInTimezone(tz);
  const dates = workingDays(end, days, tz);
  console.log(`Companion check · ${user.label} · timezone ${tz} · calendar filter ${user.calendarFilter ? user.calendarFilter.join(',') : 'none (every calendar)'}`);
  console.log(`Days: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} working days)\n`);

  // B — the independent walk: one window per active calendar, bucketed by LOCAL date.
  const cals = await listCalendars();
  if (!cals.ok || !cals.data) throw new Error(`GHL calendars could not be read: ${cals.error}`);
  const active = cals.data.calendars.filter((c) => c.isActive !== false);
  const windowStart = getDayBounds(addDays(dates[0], -1), tz).startMs;
  const windowEnd = getDayBounds(addDays(dates[dates.length - 1], 1), tz).endMs;
  const independent = new Map<string, Map<string, { calendar: string; start: string; contact: string }>>();
  for (const d of dates) independent.set(d, new Map());
  let requests = 1;
  for (const cal of active) {
    const res = await listAppointments({ startTimeMs: windowStart, endTimeMs: windowEnd, calendarId: cal.id });
    requests += 1;
    if (res.error) throw new Error(`Calendar "${cal.name}": ${res.error}`);
    for (const e of res.events) {
      if (!isAssignedTo(e, user.ghlUserId)) continue;
      const local = todayInTimezone(tz, new Date(e.startTime));
      independent.get(local)?.set(e.id, { calendar: cal.name.trim(), start: e.startTime, contact: e.contactId });
    }
  }
  console.log(`Independent walk: ${active.length} active calendars, ${requests} requests\n`);

  let failures = 0;
  for (const date of dates) {
    const a = await loadDayRaw({ ghlUserId: user.ghlUserId, date, timezone: tz, calendarFilter: user.calendarFilter, now: new Date(), live: liveGhl, mirror: readMirrorDay, cache: false });
    const m = await readMirrorDay({ ghlUserId: user.ghlUserId, startMs: getDayBounds(date, tz).startMs, endMs: getDayBounds(date, tz).endMs, calendarFilter: user.calendarFilter });
    const b = independent.get(date)!;
    const aIds = new Set(a.calls.map((c) => c.eventId));
    const onlyA = a.calls.filter((c) => !b.has(c.eventId));
    const onlyB = Array.from(b.entries()).filter(([id]) => !aIds.has(id));
    const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T12:00:00Z`));
    const ok = a.source === 'live' && onlyA.length === 0 && onlyB.length === 0;
    if (!ok) failures += 1;
    console.log(`${date} ${dow} · companion ${a.calls.length} (${a.source}) · ghl ${b.size} · mirror ${m.rows.length} · ${ok ? 'OK' : 'DIFF'}`);
    if (a.source !== 'live') console.log(`   ✗ the Companion answered from the mirror: ${a.reason}`);
    for (const c of onlyA) console.log(`   ✗ only in the Companion: ${c.eventId} · ${c.calendarName} · ${formatTime(c.startIso, tz)} · contact ${c.ghlContactId}`);
    for (const [id, e] of onlyB) console.log(`   ✗ only in the independent walk: ${id} · ${e.calendar} · ${formatTime(e.start, tz)} · contact ${e.contact}`);
    if (m.rows.length !== a.calls.length) console.log(`   i mirror differs from live by ${a.calls.length - m.rows.length} (sync lag; mirror as of ${m.asOf ?? 'unknown'})`);
  }
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${dates.length - failures} of ${dates.length} days identical between the Companion and the independent walk`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
