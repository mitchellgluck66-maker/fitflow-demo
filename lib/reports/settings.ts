/**
 * Companion stage 3, item 3 — the /reports cards: one state per report (switch, recipients, weekends, last sent /
 * next send / last error, why nothing will send) and the validated save. Owner only (the routes check).
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, emailDigests } from '@/db';
import { getSetting, setSetting, getTimezone, SETTING_KEYS } from '../settings';
import { resendConfigured } from '../email/resend';
import { nextSend, SENDS_AT_TEXT, scheduleText } from '../email/schedule';
import { formatLongDate } from '../dates';
import { REPORT_KINDS, REPORT_LABELS, REPORT_SETTING_KEYS, type ReportKind } from './kinds';
import { includeWeekends, parseRecipients } from './run';

export interface ReportCardState {
  kind: ReportKind;
  label: string;
  enabled: boolean;
  /** The stored string, as the owner typed it. */
  recipients: string;
  recipientsValid: string[];
  /** The daily only. */
  includeWeekends: boolean | null;
  schedule: string;
  nextSend: { date: string; at: string; label: string; period: { start: string; end: string } } | null;
  lastSent: { at: string; subject: string; recipients: string[] } | null;
  lastError: { at: string; error: string; status: string } | null;
  /** "On, but nothing will send: …" — null when the next scheduled run will send. */
  reason: string | null;
}

export interface ReportsSettingsState {
  timezone: string;
  email: { configured: boolean; from: string | null };
  sendsAt: string;
  reports: ReportCardState[];
}

export async function reportsSettingsState(now: Date = new Date()): Promise<ReportsSettingsState> {
  const [timezone, weekends] = await Promise.all([getTimezone(), includeWeekends()]);
  const configured = resendConfigured();
  const reports = await Promise.all(
    REPORT_KINDS.map(async (kind): Promise<ReportCardState> => {
      const [enabledRaw, recipientsRaw, lastSentRow, lastErrorRow] = await Promise.all([
        getSetting(REPORT_SETTING_KEYS[kind].enabled),
        getSetting(REPORT_SETTING_KEYS[kind].recipients),
        db.select({ sentAt: emailDigests.sentAt, subject: emailDigests.subject, recipients: emailDigests.recipients }).from(emailDigests).where(and(eq(emailDigests.kind, kind), eq(emailDigests.status, 'sent'), eq(emailDigests.isTest, false))).orderBy(desc(emailDigests.createdAt)).limit(1),
        db.select({ createdAt: emailDigests.createdAt, error: emailDigests.error, status: emailDigests.status }).from(emailDigests).where(and(eq(emailDigests.kind, kind), eq(emailDigests.status, 'failed'), eq(emailDigests.isTest, false))).orderBy(desc(emailDigests.createdAt)).limit(1),
      ]);
      const enabled = enabledRaw === 'true';
      const recipients = recipientsRaw ?? '';
      const recipientsValid = parseRecipients(recipients).valid;
      const next = nextSend(kind, now, timezone, { includeWeekends: weekends });
      const lastSent = lastSentRow[0]?.sentAt ? { at: lastSentRow[0].sentAt.toISOString(), subject: lastSentRow[0].subject, recipients: lastSentRow[0].recipients } : null;
      const lastError = lastErrorRow[0] ? { at: lastErrorRow[0].createdAt.toISOString(), error: lastErrorRow[0].error ?? 'failed', status: lastErrorRow[0].status } : null;
      // Newer than the last error → the error is history, not the card's state.
      const errorCurrent = lastError && (!lastSent || lastError.at > lastSent.at) ? lastError : null;
      const reason = !enabled ? null : !configured ? 'On, but nothing will send: RESEND_API_KEY / RESEND_FROM_EMAIL are not set — the report is rendered and archived only' : recipientsValid.length === 0 ? 'On, but nothing will send: no recipients' : null;
      return {
        kind,
        label: REPORT_LABELS[kind],
        enabled,
        recipients,
        recipientsValid,
        includeWeekends: kind === 'daily' ? weekends : null,
        schedule: scheduleText(kind, { includeWeekends: weekends }),
        nextSend: next ? { date: next.date, at: next.at.toISOString(), label: `${formatLongDate(next.date)} ~12:40 am`, period: next.period } : null,
        lastSent,
        lastError: errorCurrent,
        reason,
      };
    }),
  );
  return { timezone, email: { configured, from: process.env.RESEND_FROM_EMAIL?.trim() || null }, sendsAt: SENDS_AT_TEXT, reports };
}

export type SaveResult = { ok: true } | { ok: false; status: 400; error: string };

/** Validate and store one card's changes. An invalid address refuses the whole save and names it. */
export async function saveReportSettings(kind: ReportKind, patch: { enabled?: unknown; recipients?: unknown; includeWeekends?: unknown }): Promise<SaveResult> {
  if (patch.recipients !== undefined) {
    if (typeof patch.recipients !== 'string') return { ok: false, status: 400, error: 'recipients must be a string' };
    const parsed = parseRecipients(patch.recipients);
    if (parsed.invalid.length) return { ok: false, status: 400, error: `Invalid recipient: ${parsed.invalid.join(', ')}` };
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled must be true or false' };
  if (patch.includeWeekends !== undefined && (kind !== 'daily' || typeof patch.includeWeekends !== 'boolean')) return { ok: false, status: 400, error: 'includeWeekends applies to the daily report and must be true or false' };
  if (typeof patch.recipients === 'string') await setSetting(REPORT_SETTING_KEYS[kind].recipients, parseRecipients(patch.recipients).valid.join(', '));
  if (typeof patch.enabled === 'boolean') await setSetting(REPORT_SETTING_KEYS[kind].enabled, patch.enabled ? 'true' : 'false');
  if (typeof patch.includeWeekends === 'boolean') await setSetting(SETTING_KEYS.digestIncludeWeekends, patch.includeWeekends ? 'true' : 'false');
  return { ok: true };
}
