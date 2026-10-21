/**
 * Companion stage 3 — the one call path behind GET /api/onboarding and the three emails' onboarding sections:
 * every companion user (onboarding role, active, a linked GHL user) → their calls in the range (the mirror; TODAY on
 * the Day view reads live per user through stage 1's loader, the mirror on failure with asOf + the reason) →
 * enrichment (names, stages) → the Companion logs → stage 1's status → the ONE numbers function. Readers are
 * injectable for tests. Read-only: nothing here writes anywhere.
 */

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db, appUsers } from '@/db';
import { getTimezone } from '../settings';
import { getDayBounds, todayInTimezone, formatTime } from '../day';
import { localDate, weekStart, weekEnd, monthStart, monthEnd, formatLongDate, formatRangeLabel } from '../dates';
import { enrichCalls, type EnrichDeps } from '../companion/enrich';
import { endOf } from '../companion/day';
import { loadDayRaw, type DaySource, type LiveGhl, type MirrorReader, type RawCall } from '../companion/source';
import { liveGhl } from '../companion/service';
import { lookupMirrorContacts, readLiveContact, readMirrorDay } from '../companion/mirror';
import { onboardingLogsForEvents, type EventLogs } from './logs';
import { attentionItems, onboardingNumbers, type AttentionItem, type OnboardingCall, type OnboardingNumbers } from './numbers';

export type OnboardingRange = 'day' | 'week' | 'month';

export interface OnboardingUserSource {
  userId: string;
  name: string;
  ghlUserId: string;
  source: 'live' | 'mirror';
  /** When the data was produced (live) or last synced (mirror). */
  asOf: string | null;
  /** Why the mirror was used (live failed) — null on a live answer or a past day. */
  reason: string | null;
}

export interface OnboardingView {
  range: OnboardingRange;
  date: string;
  start: string;
  end: string;
  /** "Wed, Oct 21, 2026" / "Oct 18–24". */
  label: string;
  timezone: string;
  today: string;
  generatedAt: string;
  users: OnboardingUserSource[];
  /** Why there is nothing to show (no companion user), else null. */
  reason: string | null;
  calls: OnboardingCall[];
  numbers: OnboardingNumbers;
  attention: AttentionItem[];
}

export interface OnboardingDeps {
  live?: LiveGhl;
  mirror?: MirrorReader;
  enrich?: Pick<EnrichDeps, 'lookupContacts' | 'liveContact' | 'maxLive'>;
  logs?: (eventIds: string[], now: Date) => Promise<Map<string, EventLogs>>;
  /** The companion users (defaults to the app_users query). */
  users?: () => Promise<Array<{ id: string; name: string; ghlUserId: string }>>;
  cache?: boolean;
}

export async function companionUsers(): Promise<Array<{ id: string; name: string; ghlUserId: string }>> {
  const rows = await db
    .select({ id: appUsers.id, name: appUsers.name, ghlUserId: appUsers.ghlUserId })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'onboarding'), eq(appUsers.active, true), isNotNull(appUsers.ghlUserId)))
    .orderBy(asc(appUsers.createdAt));
  return rows.filter((r): r is { id: string; name: string; ghlUserId: string } => Boolean(r.ghlUserId));
}

export function rangeFor(range: OnboardingRange, date: string): { start: string; end: string } {
  if (range === 'week') return { start: weekStart(date), end: weekEnd(date) };
  if (range === 'month') return { start: monthStart(date), end: monthEnd(date) };
  return { start: date, end: date };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(date: string): boolean {
  return DATE_RE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

/** The calls of one user over the range: live for today's Day view, the mirror otherwise. */
async function callsForUser(p: { user: { id: string; name: string; ghlUserId: string }; range: OnboardingRange; start: string; end: string; today: string; timezone: string; now: Date; deps: OnboardingDeps }): Promise<{ source: OnboardingUserSource; raw: RawCall[] }> {
  const { user, timezone, now, deps } = p;
  const mirror = deps.mirror ?? readMirrorDay;
  if (p.range === 'day' && p.start === p.today) {
    const day: DaySource = await loadDayRaw({ ghlUserId: user.ghlUserId, date: p.start, timezone, calendarFilter: null, now, live: deps.live ?? liveGhl, mirror, cache: deps.cache });
    return { source: { userId: user.id, name: user.name, ghlUserId: user.ghlUserId, source: day.source, asOf: day.asOf, reason: day.reason }, raw: day.calls };
  }
  const { startMs } = getDayBounds(p.start, timezone);
  const { endMs } = getDayBounds(p.end, timezone);
  const m = await mirror({ ghlUserId: user.ghlUserId, startMs, endMs, calendarFilter: null });
  return { source: { userId: user.id, name: user.name, ghlUserId: user.ghlUserId, source: 'mirror', asOf: m.asOf, reason: null }, raw: m.rows };
}

export async function getOnboardingView(params: { range?: string | null; date?: string | null; now?: Date; timezone?: string }, deps: OnboardingDeps = {}): Promise<OnboardingView | { error: string; detail: string }> {
  const now = params.now ?? new Date();
  const timezone = params.timezone ?? (await getTimezone());
  const today = todayInTimezone(timezone, now);
  const range: OnboardingRange = params.range === 'week' ? 'week' : params.range === 'month' ? 'month' : 'day';
  const date = params.date ?? today;
  if (!isValidDay(date)) return { error: 'Bad date', detail: 'Use YYYY-MM-DD.' };
  const { start, end } = rangeFor(range, date);
  const users = await (deps.users ?? companionUsers)();
  const label = range === 'day' ? formatLongDate(start) : formatRangeLabel(start, end);
  const head = { range, date, start, end, label, timezone, today, generatedAt: now.toISOString() };
  if (users.length === 0) {
    return { ...head, users: [], reason: 'No onboarding login with a GoHighLevel user — add one in Setup → Users.', calls: [], numbers: onboardingNumbers([]), attention: [] };
  }

  const perUser = await Promise.all(users.map((user) => callsForUser({ user, range, start, end, today, timezone, now, deps })));
  const logsReader = deps.logs ?? onboardingLogsForEvents;
  const allRaw = perUser.flatMap((u) => u.raw.map((r) => ({ raw: r, userName: u.source.name })));
  const logs = await logsReader(allRaw.map((r) => r.raw.eventId), now);
  const enriched = await enrichCalls(
    allRaw.map((r) => r.raw),
    now,
    {
      lookupContacts: deps.enrich?.lookupContacts ?? lookupMirrorContacts,
      liveContact: deps.enrich?.liveContact ?? readLiveContact,
      maxLive: deps.enrich?.maxLive,
      actions: async (ids) => {
        const m = new Map();
        for (const id of ids) {
          const a = logs.get(id)?.callAction;
          if (a) m.set(id, a);
        }
        return m;
      },
    },
  );
  const userOf = new Map(allRaw.map((r) => [r.raw.eventId, r.userName]));
  const calls: OnboardingCall[] = enriched
    .map((c) => {
      const l = logs.get(c.eventId);
      return {
        eventId: c.eventId,
        date: localDate(new Date(c.startIso), timezone),
        startIso: c.startIso,
        endIso: c.endIso,
        timeLabel: formatTime(c.startIso, timezone),
        callType: c.callType,
        calendarName: c.calendarName,
        ghlContactId: c.ghlContactId,
        contactId: c.contactId,
        name: c.name,
        userName: userOf.get(c.eventId) ?? '',
        status: c.status,
        outcomeInGhl: c.outcomeInGhl,
        ended: endOf(c) <= now.getTime(),
        log: l?.log ?? null,
        undone: l?.undone ?? null,
      };
    })
    .sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso) || a.eventId.localeCompare(b.eventId));
  return { ...head, users: perUser.map((u) => u.source), reason: null, calls, numbers: onboardingNumbers(calls), attention: attentionItems(calls) };
}
