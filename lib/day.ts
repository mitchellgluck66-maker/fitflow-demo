/**
 * Local business-day helpers.
 *
 * GHL's appointment list endpoint takes epoch milliseconds - absolute instants
 * with no timezone context. "Today" is a local concept, so we have to convert a
 * calendar date in the business's timezone into the correct UTC instant range
 * ourselves. Getting this wrong is how a 9pm appointment ends up on tomorrow's
 * sheet, so it lives in one place.
 */

/** Offset in minutes between UTC and the given IANA timezone at a given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  // Format the instant in the target zone, reparse as if it were UTC, and the
  // difference is the offset. Handles DST correctly because it asks Intl for the
  // offset in effect at that specific instant.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );

  // Round to whole minutes: formatToParts drops milliseconds, and the
  // sub-minute remainder would otherwise leak into the day boundary.
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Start and end instants for a local calendar day.
 * `dateStr` is a plain YYYY-MM-DD with no timezone of its own.
 */
export function getDayBounds(
  dateStr: string,
  timeZone: string,
): { startMs: number; endMs: number; startIso: string; endIso: string } {
  const [year, month, day] = dateStr.split('-').map(Number);

  // First approximation: treat local midnight as UTC midnight...
  const naiveStart = Date.UTC(year, month - 1, day, 0, 0, 0);
  // ...then correct by the offset actually in effect near that moment.
  const offset = tzOffsetMinutes(new Date(naiveStart), timeZone);
  const startMs = naiveStart - offset * 60_000;

  const naiveEnd = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const endOffset = tzOffsetMinutes(new Date(naiveEnd), timeZone);
  const endMs = naiveEnd - endOffset * 60_000;

  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** Today's date as YYYY-MM-DD in the given timezone. */
export function todayInTimezone(timeZone: string): string {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(now); // en-CA formats as YYYY-MM-DD
}

/** Shift a YYYY-MM-DD date string by N days, staying calendar-correct. */
export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Wednesday, August 19, 2026" */
export function formatDayLabel(dateStr: string, timeZone: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12)); // midday avoids DST edges
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

/** "9:30 AM" from an ISO timestamp, rendered in the business timezone. */
export function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return '--:--';
  }
}

export function isToday(dateStr: string, timeZone: string): boolean {
  return dateStr === todayInTimezone(timeZone);
}

/** Milliseconds until the next local midnight - used to schedule the sync job. */
export function msUntilMidnight(timeZone: string): number {
  const today = todayInTimezone(timeZone);
  const tomorrow = addDays(today, 1);
  const { startMs } = getDayBounds(tomorrow, timeZone);
  return Math.max(1000, startMs - Date.now());
}
