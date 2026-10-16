/**
 * Companion stage 1 — which GHL events are "my calls" (pure).
 *
 * Matching is by ASSIGNED USER, never by a calendar list: Miranda's appointments span nine calendars (four more than
 * the brief listed, one renamed), so a new calendar appears automatically. The calendar list is only a per-user
 * FILTER (item 4) — null / empty = every calendar.
 */

export type CallType = 'Consult' | 'Roadmap' | 'Other';

/** Consult / Roadmap from the calendar name (the title as a tiebreak); anything else keeps its own name as "Other". */
export function callTypeOf(calendarName: string | null | undefined, title?: string | null): CallType {
  const s = `${calendarName ?? ''} ${title ?? ''}`.toLowerCase();
  if (s.includes('roadmap') || s.includes('strategy')) return 'Roadmap';
  if (s.includes('consult')) return 'Consult';
  return 'Other';
}

export interface AssignableEvent {
  assignedUserId?: string | null;
  users?: string[] | null;
}

/** The event is the user's when GHL assigned it to them, or lists them among the event's users. */
export function isAssignedTo(event: AssignableEvent, ghlUserId: string | null | undefined): boolean {
  if (!ghlUserId) return false;
  if (event.assignedUserId === ghlUserId) return true;
  return Array.isArray(event.users) && event.users.includes(ghlUserId);
}

/** The per-user calendar filter: null or empty = all calendars. */
export function inCalendarFilter(calendarId: string, filter: readonly string[] | null | undefined): boolean {
  if (!filter || filter.length === 0) return true;
  return filter.includes(calendarId);
}

/** A readable calendar label (GHL names carry stray spaces: " Quick Connect with Miranda", "15-Minute … Consult "). */
export function calendarLabel(name: string | null | undefined, id: string): string {
  const n = (name ?? '').trim();
  return n || `Calendar ${id}`;
}
