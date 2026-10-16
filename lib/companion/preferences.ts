/**
 * Companion stage 1, item 4 — per-user preferences (pure validation). Stored on app_users.preferences.
 *   calendarIds  null = every calendar where the user is assigned; otherwise an explicit list of GHL calendar ids
 *   timezone     IANA zone for "my day"; null = the business timezone
 *   autoAdvance  the pop-out follows the clock (default on)
 */

import { isValidTimezone } from '../settings';
import type { CompanionPreferences } from '@/db';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type PreferencesCheck = { ok: true; prefs: CompanionPreferences } | { ok: false; error: string };

/** Only the keys present in `input` are validated and returned (a PATCH); unknown keys are dropped. */
export function validatePreferences(input: unknown): PreferencesCheck {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Send an object of preferences.' };
  const body = input as Record<string, unknown>;
  const prefs: CompanionPreferences = {};
  if ('calendarIds' in body) {
    const v = body.calendarIds;
    if (v === null) prefs.calendarIds = null;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && ID_RE.test(x))) prefs.calendarIds = Array.from(new Set(v as string[]));
    else return { ok: false, error: 'calendarIds must be null or a list of GoHighLevel calendar ids.' };
  }
  if ('timezone' in body) {
    const v = body.timezone;
    if (v === null || v === '') prefs.timezone = null;
    else if (typeof v === 'string' && isValidTimezone(v)) prefs.timezone = v;
    else return { ok: false, error: `"${String(v)}" is not a valid IANA timezone.` };
  }
  if ('autoAdvance' in body) {
    if (typeof body.autoAdvance !== 'boolean') return { ok: false, error: 'autoAdvance must be true or false.' };
    prefs.autoAdvance = body.autoAdvance;
  }
  return { ok: true, prefs };
}

/** A short list of zones for the settings select: the business zone first, then North America, then the rest. */
export function timezoneOptions(businessTimezone: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const america = all.filter((z) => z.startsWith('America/'));
  const rest = all.filter((z) => !z.startsWith('America/'));
  return Array.from(new Set([businessTimezone, ...america, ...rest]));
}
