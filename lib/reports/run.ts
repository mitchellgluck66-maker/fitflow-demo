/**
 * Companion stage 3 — the report runner: decide the period → build → send / store → record in email_digests.
 * Replaces lib/email/send#runDigest with the same archive semantics (2026-09-29 heartbeat rules), plus:
 *
 *   off switch (report_<kind>_enabled ≠ 'true')   → 'disabled', nothing built, nothing stored (force / test still run)
 *   test send (`test: true`, `to` required)       → archived with is_test = true; NEVER consults or satisfies the
 *                                                    period's scheduled send
 *   the 3rd recorded failure for a period         → ONE open `report_failed` warning incident per kind
 *                                                    (details.kind / period), resolved by the next successful send
 *   no recipients / no Resend key                 → recorded with the reason (failed / stored), never silent
 */

import { and, eq } from 'drizzle-orm';
import { db, emailDigests, syncIncidents } from '@/db';
import { and as andOp, isNull } from 'drizzle-orm';
import { getSetting, getTimezone, SETTING_KEYS } from '../settings';
import { sendEmail, resendConfigured } from '../email/resend';
import { reportDecision, type ScheduleDecision } from '../email/schedule';
import { buildReport } from './build';
import { REPORT_LABELS, REPORT_SETTING_KEYS, type ReportKind } from './kinds';

export type ReportStatus = 'sent' | 'stored' | 'skipped_empty' | 'failed' | 'already_sent' | 'already_recorded' | 'retries_exhausted' | 'disabled';

/** Unforced sends stop retrying a period after this many recorded failures; the 3rd opens the incident. */
export const MAX_FAILED_ATTEMPTS = 3;
export const REPORT_INCIDENT_KIND = 'report_failed';

export interface ReportRunResult {
  kind: ReportKind;
  status: ReportStatus;
  periodStart: string;
  periodEnd: string;
  recipients: string[];
  subject: string;
  test: boolean;
  digestId?: string;
  resendId?: string;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: split a recipients string; the invalid entries come back separately so a save can refuse them by name. */
export function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = Array.from(new Set(parts.filter((s) => EMAIL_RE.test(s)).map((s) => s.toLowerCase())));
  const invalid = parts.filter((s) => !EMAIL_RE.test(s));
  return { valid, invalid };
}

/** Owner setting "Include weekends" (d7076e4): only the literal 'true' turns it on (default off). */
export async function includeWeekends(): Promise<boolean> {
  return (await getSetting(SETTING_KEYS.digestIncludeWeekends)) === 'true';
}

export async function reportEnabled(kind: ReportKind): Promise<boolean> {
  return (await getSetting(REPORT_SETTING_KEYS[kind].enabled)) === 'true';
}

export async function reportRecipients(kind: ReportKind): Promise<string[]> {
  return parseRecipients((await getSetting(REPORT_SETTING_KEYS[kind].recipients)) ?? '').valid;
}

export async function decideReport(kind: ReportKind, now: Date, timezone?: string): Promise<ScheduleDecision> {
  const [tz, weekends] = await Promise.all([timezone ? Promise.resolve(timezone) : getTimezone(), includeWeekends()]);
  return reportDecision(kind, now, tz, { includeWeekends: weekends });
}

async function noteFailure(kind: ReportKind, period: { start: string; end: string }, failures: number, error: string): Promise<void> {
  if (failures < MAX_FAILED_ATTEMPTS) return;
  const [open] = await db.select({ id: syncIncidents.id }).from(syncIncidents).where(andOp(eq(syncIncidents.kind, REPORT_INCIDENT_KIND), isNull(syncIncidents.resolvedAt), eq(syncIncidents.message, incidentMessage(kind)))).limit(1);
  const details = { kind, period, failures, error, at: new Date().toISOString() };
  if (open) await db.update(syncIncidents).set({ details }).where(eq(syncIncidents.id, open.id));
  else await db.insert(syncIncidents).values({ kind: REPORT_INCIDENT_KIND, severity: 'warning', message: incidentMessage(kind), details });
}

export const incidentMessage = (kind: ReportKind) => `${REPORT_LABELS[kind]} could not be sent ${MAX_FAILED_ATTEMPTS} times — check Resend and the recipients on /reports`;

async function noteSuccess(kind: ReportKind, digestId: string): Promise<void> {
  const open = await db.select({ id: syncIncidents.id }).from(syncIncidents).where(andOp(eq(syncIncidents.kind, REPORT_INCIDENT_KIND), isNull(syncIncidents.resolvedAt), eq(syncIncidents.message, incidentMessage(kind))));
  for (const o of open) await db.update(syncIncidents).set({ resolvedAt: new Date(), details: { resolvedBy: `sent ${digestId}` } }).where(eq(syncIncidents.id, o.id));
}

export async function runReport(kind: ReportKind, options: { force?: boolean; test?: boolean; to?: string[]; now?: Date; period?: { start: string; end: string } } = {}): Promise<ReportRunResult> {
  const now = options.now ?? new Date();
  const test = Boolean(options.test);
  const force = Boolean(options.force) || test;
  const recipients = test ? (options.to ?? []) : await reportRecipients(kind);
  const decision = await decideReport(kind, now);
  const period = options.period ?? decision.period;
  const base = { kind, periodStart: period.start, periodEnd: period.end, recipients, test };

  if (!force && !(await reportEnabled(kind))) return { ...base, status: 'disabled', subject: '' };
  if (test && recipients.length === 0) return { ...base, status: 'failed', subject: '', error: 'A test send needs an address' };

  let failures = 0;
  if (!force) {
    const prior = await db
      .select({ id: emailDigests.id, status: emailDigests.status })
      .from(emailDigests)
      .where(and(eq(emailDigests.kind, kind), eq(emailDigests.periodStart, period.start), eq(emailDigests.periodEnd, period.end), eq(emailDigests.isTest, false)));
    const sent = prior.find((r) => r.status === 'sent');
    if (sent) return { ...base, status: 'already_sent', subject: '', digestId: sent.id };
    const recorded = prior.find((r) => r.status === 'stored' || r.status === 'skipped_empty');
    if (recorded) return { ...base, status: 'already_recorded', subject: '', digestId: recorded.id, error: `already ${recorded.status} for this period` };
    failures = prior.filter((r) => r.status === 'failed').length;
    if (failures >= MAX_FAILED_ATTEMPTS) return { ...base, status: 'retries_exhausted', subject: '', error: `${failures} failed attempts for this period — use Send test / Send now on /reports` };
  }

  const built = await buildReport(kind, period, { now });
  const subject = test ? `[TEST] ${built.model.subject}` : built.model.subject;
  const record = async (status: ReportStatus, extra: { resendId?: string; error?: string; sentAt?: Date } = {}) => {
    const [row] = await db
      .insert(emailDigests)
      .values({ kind, periodStart: period.start, periodEnd: period.end, recipients, subject, html: built.html, textBody: built.text, status, resendId: extra.resendId ?? null, error: extra.error ?? null, sentAt: extra.sentAt ?? null, isTest: test })
      .returning({ id: emailDigests.id });
    return row.id;
  };
  const withSubject = { ...base, subject };

  if (built.model.empty && !force) return { ...withSubject, status: 'skipped_empty', digestId: await record('skipped_empty') };
  if (!resendConfigured()) return { ...withSubject, status: 'stored', digestId: await record('stored', { error: 'RESEND_API_KEY / RESEND_FROM_EMAIL not configured' }) };
  if (recipients.length === 0) {
    const error = 'No valid recipients configured';
    const id = await record('failed', { error });
    if (!test) await noteFailure(kind, period, failures + 1, error);
    return { ...withSubject, status: 'failed', error, digestId: id };
  }
  const result = await sendEmail({ to: recipients, subject, html: built.html, text: built.text });
  if (result.sent) {
    const id = await record('sent', { resendId: result.id, sentAt: now });
    if (!test) await noteSuccess(kind, id);
    return { ...withSubject, status: 'sent', resendId: result.id, digestId: id };
  }
  const id = await record('failed', { error: result.error });
  if (!test) await noteFailure(kind, period, failures + 1, result.error ?? 'send failed');
  return { ...withSubject, status: 'failed', error: result.error, digestId: id };
}
