/**
 * Digest runner: build → decide → send/store → record in email_digests.
 *
 *   empty & !force        → 'skipped_empty' row, nothing sent
 *   no RESEND_API_KEY     → 'stored' row (rendered, viewable in Reports)
 *   already sent, !force  → 'already_sent' (no new row)
 *   already stored / skipped_empty for the period, !force → 'already_recorded' (no new row)
 *   MAX_FAILED_ATTEMPTS failures for the period, !force  → 'retries_exhausted' (no new row)
 *   otherwise             → send; 'sent' or 'failed'
 *
 * 2026-09-29 heartbeat: the dispatch now runs hourly, so a period's
 * outcome must be decided ONCE — otherwise an unconfigured Resend or an empty
 * day would archive a new row on every run from 6am to midnight, and a
 * failing send would retry ~18 times. A manual "Send now" (force) bypasses all
 * three.
 */

import { and, eq } from 'drizzle-orm';
import { db, emailDigests } from '@/db';
import { getSetting, SETTING_KEYS } from '../settings';
import { buildDigest, type DigestKind } from './digests';
import { sendEmail, resendConfigured } from './resend';

export type DigestStatus = 'sent' | 'stored' | 'skipped_empty' | 'failed' | 'already_sent' | 'already_recorded' | 'retries_exhausted' | 'disabled';

/** Unforced sends stop retrying a period after this many recorded failures. */
export const MAX_FAILED_ATTEMPTS = 3;

export interface DigestRunResult {
  kind: DigestKind;
  status: DigestStatus;
  periodStart: string;
  periodEnd: string;
  recipients: string[];
  subject: string;
  digestId?: string;
  resendId?: string;
  error?: string;
}

const RECIPIENT_KEY: Record<DigestKind, string> = {
  daily_todo: SETTING_KEYS.digestRecipientsTodo,
  weekly: SETTING_KEYS.digestRecipientsWeekly,
  monthly: SETTING_KEYS.digestRecipientsMonthly,
};

const ENABLED_KEY: Record<DigestKind, string> = {
  daily_todo: SETTING_KEYS.digestEnabledTodo,
  weekly: SETTING_KEYS.digestEnabledWeekly,
  monthly: SETTING_KEYS.digestEnabledMonthly,
};

export async function digestEnabled(kind: DigestKind): Promise<boolean> {
  return (await getSetting(ENABLED_KEY[kind])) !== 'false';
}

export async function resolveRecipients(kind: DigestKind): Promise<string[]> {
  const raw = (await getSetting(RECIPIENT_KEY[kind])) ?? '';
  return Array.from(
    new Set(
      raw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    ),
  );
}

export async function runDigest(kind: DigestKind, options: { force?: boolean; today?: string } = {}): Promise<DigestRunResult> {
  const recipients = await resolveRecipients(kind);
  // Disabled in Reports → nothing built, nothing stored (force = manual "Send now" still works).
  if (!options.force && !(await digestEnabled(kind))) {
    return { kind, status: 'disabled', periodStart: '', periodEnd: '', recipients, subject: '' };
  }
  const digest = await buildDigest(kind, options.today);
  const base = { kind, periodStart: digest.periodStart, periodEnd: digest.periodEnd, recipients, subject: digest.subject };

  if (!options.force) {
    const prior = await db
      .select({ id: emailDigests.id, status: emailDigests.status })
      .from(emailDigests)
      .where(and(eq(emailDigests.kind, kind), eq(emailDigests.periodStart, digest.periodStart), eq(emailDigests.periodEnd, digest.periodEnd)));
    const sent = prior.find((r) => r.status === 'sent');
    if (sent) return { ...base, status: 'already_sent', digestId: sent.id };
    const recorded = prior.find((r) => r.status === 'stored' || r.status === 'skipped_empty');
    if (recorded) return { ...base, status: 'already_recorded', digestId: recorded.id, error: `already ${recorded.status} for this period` };
    const failures = prior.filter((r) => r.status === 'failed').length;
    if (failures >= MAX_FAILED_ATTEMPTS) {
      return { ...base, status: 'retries_exhausted', error: `${failures} failed attempts for this period — use Send now on /reports` };
    }
  }

  const record = async (status: DigestStatus, extra: { resendId?: string; error?: string; sentAt?: Date } = {}) => {
    const [row] = await db
      .insert(emailDigests)
      .values({
        kind,
        periodStart: digest.periodStart,
        periodEnd: digest.periodEnd,
        recipients,
        subject: digest.subject,
        html: digest.html,
        textBody: digest.text,
        status,
        resendId: extra.resendId ?? null,
        error: extra.error ?? null,
        sentAt: extra.sentAt ?? null,
      })
      .returning({ id: emailDigests.id });
    return row.id;
  };

  if (digest.empty && !options.force) {
    return { ...base, status: 'skipped_empty', digestId: await record('skipped_empty') };
  }

  if (!resendConfigured()) {
    return { ...base, status: 'stored', digestId: await record('stored', { error: 'RESEND_API_KEY / RESEND_FROM_EMAIL not configured' }) };
  }

  if (recipients.length === 0) {
    return { ...base, status: 'failed', error: 'no recipients', digestId: await record('failed', { error: 'No valid recipients configured' }) };
  }

  const result = await sendEmail({ to: recipients, subject: digest.subject, html: digest.html, text: digest.text });
  if (result.sent) {
    return { ...base, status: 'sent', resendId: result.id, digestId: await record('sent', { resendId: result.id, sentAt: new Date() }) };
  }
  return { ...base, status: 'failed', error: result.error, digestId: await record('failed', { error: result.error }) };
}
