/**
 * Meta token self-check (H2, 2026-09-29 audit).
 *
 * The token pasted on Sept 1 may be a 60-day user token; if it is, Meta spend
 * stops syncing around the end of October and the stale banner would only
 * notice a day AFTER. The nightly dispatch now asks Meta's own debug_token
 * endpoint (one GET) when the stored token expires, keeps the answer in
 * settings (`meta_token_status`), shows it in Setup → Sync health, and raises
 * ONE open `meta_token` incident from 7 days before expiry ("Meta token
 * expires Oct 31, 2026 — regenerate in Business Settings"), critical once it
 * has expired or Meta says it is invalid. The incident resolves itself when
 * a regenerated token checks out.
 *
 * `assessMetaToken` is pure; the rest is the thin DB side.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { getSetting, getTimezone, setSetting } from '../settings';
import { getMetaConfig } from './config';
import { metaRequest } from './client';
import { MetaDebugTokenSchema, type MetaDebugToken } from './schemas';

export const META_TOKEN_STATUS_KEY = 'meta_token_status';
export const META_TOKEN_INCIDENT_KIND = 'meta_token';
/** Warn this many days ahead of expiry. */
export const EXPIRY_WARNING_DAYS = 7;

export interface MetaTokenStatus {
  checkedAt: string;
  valid: boolean;
  /** ISO instant; null = never expires. */
  expiresAt: string | null;
  /** Meta's separate data-access window (user tokens); null = none / never. */
  dataAccessExpiresAt: string | null;
  type: string | null;
  scopes: string[];
  /** Meta's own reason when is_valid is false. */
  error: string | null;
}

export type TokenLevel = 'ok' | 'warning' | 'expired' | 'invalid';

export interface TokenAssessment {
  level: TokenLevel;
  /** Whole days until the earliest expiry (floor); null when it never expires. */
  daysLeft: number | null;
  /** Which clock is closest: the token itself or Meta's data-access window. */
  which: 'token' | 'data_access' | null;
  /** The earliest expiry, ISO; null = never. */
  expiresAt: string | null;
  /** One line for Sync health / the incident. */
  message: string;
}

const iso = (unix: number | null | undefined): string | null => (unix && unix > 0 ? new Date(unix * 1000).toISOString() : null);

export function statusFromDebugToken(res: MetaDebugToken, checkedAt: Date): MetaTokenStatus {
  const d = res.data;
  return {
    checkedAt: checkedAt.toISOString(),
    valid: d.is_valid,
    expiresAt: iso(d.expires_at),
    dataAccessExpiresAt: iso(d.data_access_expires_at),
    type: d.type ?? null,
    scopes: d.scopes ?? [],
    error: d.error?.message ?? null,
  };
}

/** "Oct 31, 2026" in the business timezone. */
export function formatExpiryDate(isoInstant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(isoInstant));
}

/** Pure: what the stored status means at `nowMs`. */
export function assessMetaToken(s: MetaTokenStatus, nowMs: number, timezone: string): TokenAssessment {
  const candidates = (
    [
      ['token', s.expiresAt],
      ['data_access', s.dataAccessExpiresAt],
    ] as const
  ).filter((c): c is readonly ['token' | 'data_access', string] => c[1] !== null);
  const earliest = candidates.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]))[0] ?? null;
  const daysLeft = earliest ? Math.floor((Date.parse(earliest[1]) - nowMs) / 86_400_000) : null;
  const which = earliest ? earliest[0] : null;
  const expiresAt = earliest ? earliest[1] : null;
  const when = expiresAt ? formatExpiryDate(expiresAt, timezone) : null;
  const subject = which === 'data_access' ? 'Meta data access' : 'Meta token';

  if (!s.valid) {
    const expired = expiresAt !== null && Date.parse(expiresAt) <= nowMs;
    return {
      level: expired ? 'expired' : 'invalid',
      daysLeft,
      which,
      expiresAt,
      message: expired
        ? `${subject} expired ${when} — regenerate in Business Settings; Meta spend has stopped syncing`
        : `Meta says the token is invalid${s.error ? ` (${s.error})` : ''} — regenerate in Business Settings`,
    };
  }
  if (expiresAt === null) return { level: 'ok', daysLeft: null, which: null, expiresAt: null, message: 'Meta token never expires' };
  if (Date.parse(expiresAt) <= nowMs) {
    return { level: 'expired', daysLeft, which, expiresAt, message: `${subject} expired ${when} — regenerate in Business Settings; Meta spend has stopped syncing` };
  }
  if (daysLeft !== null && daysLeft < EXPIRY_WARNING_DAYS) {
    return { level: 'warning', daysLeft, which, expiresAt, message: `${subject} expires ${when} — regenerate in Business Settings` };
  }
  return { level: 'ok', daysLeft, which, expiresAt, message: `${subject} expires ${when} (${daysLeft} days)` };
}

export async function readMetaTokenStatus(): Promise<MetaTokenStatus | null> {
  const raw = await getSetting(META_TOKEN_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaTokenStatus;
  } catch {
    return null;
  }
}

/** One open meta_token incident at most, always describing the latest check; resolved when the token is fine. */
async function syncIncident(a: TokenAssessment, status: MetaTokenStatus, now: Date): Promise<void> {
  const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, META_TOKEN_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
  if (a.level === 'ok') {
    for (const inc of open) await db.update(syncIncidents).set({ resolvedAt: now }).where(eq(syncIncidents.id, inc.id));
    return;
  }
  const severity = a.level === 'warning' ? 'warning' : 'critical';
  const current = open.find((i) => i.message === a.message && i.severity === severity);
  for (const inc of open) if (inc !== current) await db.update(syncIncidents).set({ resolvedAt: now }).where(eq(syncIncidents.id, inc.id));
  const details = { expiresAt: a.expiresAt, which: a.which, daysLeft: a.daysLeft, checkedAt: status.checkedAt, type: status.type };
  if (current) await db.update(syncIncidents).set({ details }).where(eq(syncIncidents.id, current.id));
  else await db.insert(syncIncidents).values({ kind: META_TOKEN_INCIDENT_KIND, severity, message: a.message, details, createdAt: now });
}

export interface MetaTokenCheckResult {
  ok: boolean;
  notConfigured?: boolean;
  error?: string;
  /** Recorded as the dispatch step's reason. */
  reason?: string;
  status?: MetaTokenStatus;
  assessment?: TokenAssessment;
}

/** Nightly dispatch step + Setup "Check now": ask Meta, store, raise/resolve the incident. */
export async function runMetaTokenCheck(now: Date = new Date()): Promise<MetaTokenCheckResult> {
  const config = await getMetaConfig();
  if (!config.configured || !config.token) return { ok: false, notConfigured: true };
  const res = await metaRequest('/debug_token', { input_token: config.token }, MetaDebugTokenSchema);
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? 'debug_token failed' };

  const status = statusFromDebugToken(res.data, now);
  await setSetting(META_TOKEN_STATUS_KEY, JSON.stringify(status));
  const assessment = assessMetaToken(status, now.getTime(), await getTimezone());
  await syncIncident(assessment, status, now);
  return { ok: assessment.level !== 'expired' && assessment.level !== 'invalid', status, assessment, reason: assessment.message, error: assessment.level === 'ok' || assessment.level === 'warning' ? undefined : assessment.message };
}
