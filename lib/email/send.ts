/**
 * Digest runner: build → decide → send/store → record in email_digests.
 *
 *   empty & !force        → 'skipped_empty' row, nothing sent
 *   no RESEND_API_KEY     → 'stored' row (rendered, viewable in Reports)
 *   already sent, !force  → 'already_sent' (no new row)
 *   otherwise             → send; 'sent' or 'failed'
 */

import { and, eq } from 'drizzle-orm';
import { db, emailDigests } from '@/db';
import { getSetting, SETTING_KEYS } from '../settings';
import { buildDigest, type DigestKind } from './digests';
import { sendEmail, resendConfigured } from './resend';

export type DigestStatus = 'sent' | 'stored' | 'skipped_empty' | 'failed' | 'already_sent' | 'disabled';

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
      .select({ id: emailDigests.id })
      .from(emailDigests)
      .where(
        and(
          eq(emailDigests.kind, kind),
          eq(emailDigests.periodStart, digest.periodStart),
          eq(emailDigests.periodEnd, digest.periodEnd),
          eq(emailDigests.status, 'sent'),
        ),
      )
      .limit(1);
    if (prior.length > 0) return { ...base, status: 'already_sent', digestId: prior[0].id };
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
