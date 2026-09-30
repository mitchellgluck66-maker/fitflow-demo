/**
 * Persisted app settings (key/value in the `settings` table).
 *
 * Credentials live here too (entered in /setup, verified on save). Rows flagged
 * `isSecret` are never returned unmasked by any API route — see
 * lib/ghl/config.ts#maskToken. Env vars are the fallback when nothing is stored.
 *
 * H4 (2026-09-29): secret rows are stored AES-256-GCM encrypted with env
 * CREDENTIALS_KEY (lib/crypto/credentials). This file is the ONLY place they
 * are sealed (setSetting) and opened (getSetting) — server-side, at call time.
 */

import { db, settings } from '@/db';
import { and, eq, not, like, ne } from 'drizzle-orm';
import { ENC_PREFIX, keyStatus, openSecret, sealSecret } from './crypto/credentials';

export const SETTING_KEYS = {
  timezone: 'timezone',
  /** Business-local date (YYYY-MM-DD) of the last sync_runs prune (lib/syncRunsPrune). */
  syncRunsPrunedOn: 'sync_runs_pruned_on',
  /** Comma-separated recipient lists per digest. */
  digestRecipients: 'digest_recipients',
  digestRecipientsTodo: 'digest_recipients_todo',
  digestRecipientsWeekly: 'digest_recipients_weekly',
  digestRecipientsMonthly: 'digest_recipients_monthly',
  digestEnabledTodo: 'digest_enabled_todo',
  digestEnabledWeekly: 'digest_enabled_weekly',
  digestEnabledMonthly: 'digest_enabled_monthly',
  summaryRecipientEmail: 'summary_recipient_email',
  summaryRecipientHistory: 'summary_recipient_history',
  /** ISO timestamp of the last successful GHL delta sync (delta lower bound). */
  ghlLastSyncAt: 'ghl_last_sync_at',
  /**
   * Resumable GHL sync cursor (JSON, lib/ghl/ingest.ts#SyncCursor): where the
   * current delta/backfill cycle stopped when the last run hit its time
   * budget. Cleared when a cycle completes.
   */
  ghlSyncCursor: 'ghl_sync_cursor',
  /** Ingestion v2 (2026-09-30): the weekly mirror pass's cursor — the only GHL cursor (lib/ghl/ingest.ts). */
  ghlMirrorCursor: 'ghl_mirror_cursor',
  /**
   * Cycle-by-value markers (2026-09-29): when each DATA FAMILY the dashboard
   * displays last completed inside a cycle — stages/opportunities of the
   * FOLLOWED pipelines, and appointments. Written by the phase that finishes
   * them, whether or not the untracked mirrors ever complete. The stale banner
   * and sync-health key off these, never off run activity.
   */
  ghlTrackedOppsCompletedAt: 'ghl_tracked_opps_completed_at',
  ghlAppointmentsCompletedAt: 'ghl_appointments_completed_at',
  /** ISO cycleStartedAt of the last cycle whose TRACKED phases completed — reconciliation is eligible from here. */
  ghlTrackedCompletedAt: 'ghl_tracked_completed_at',
  /**
   * Stripe (2026-09-30, lib/stripe/ingest): the hourly DELTA lists only what
   * was created since `stripe_delta_since` (minus an overlap); the heavy
   * RECONCILE (7 days of charges/refunds + every subscription) runs when
   * `stripe_reconcile_completed_at` is older than its cadence, resumably via
   * `stripe_sync_cursor` (JSON; '' when none is in progress).
   */
  stripeDeltaSince: 'stripe_delta_since',
  stripeReconcileCompletedAt: 'stripe_reconcile_completed_at',
  stripeSyncCursor: 'stripe_sync_cursor',
  /** F12 (2026-09-30): the per-day completeness sweep — its cursor and its last summary (lib/stripe/completeness.ts). */
  stripeCompletenessCursor: 'stripe_completeness_cursor',
  stripeCompleteness: 'stripe_completeness',
  /** Ingestion v2 (2026-09-30): the last cron invocation {route, at, via} — the scheduler-silent check (lib/sync/scheduler.ts). */
  schedulerLastRun: 'scheduler_last_run',
  /** F3 (2026-09-30): the first-run utm backfill's completion {version, at, counts} (lib/attribution/utmBackfill.ts). */
  utmBackfill: 'utm_backfill',
  /** Dispatch fairness + stuck detection (lib/dispatch.ts): per-step history, JSON. */
  dispatchState: 'dispatch_state',
  /** ISO date the GHL / Stripe backfill starts from (Phase G: 2026-06-01). */
  backfillFrom: 'backfill_from',
  /**
   * ISO date the META backfill starts from — 2026-07-16, the VSL campaign
   * launch; Meta history before that is noise. Meta reads this key only.
   */
  metaBackfillFrom: 'meta_backfill_from',
  /**
   * First day the Meta backfill has NOT yet covered — written after every
   * completed ≤7-day chunk, cleared ('') when a backfill finishes. Lets a
   * re-run resume a partial backfill instead of restarting.
   */
  metaBackfillCursor: 'meta_backfill_cursor',
  /** F13 (2026-09-30): the Meta ad account as last read — {id, name, currency, timezone, checkedAt}. */
  metaAccount: 'meta_account',
  /** The daily account-level Meta spend check's last summary (lib/meta/ingest#runMetaSpendCheck). */
  metaSpendCheck: 'meta_spend_check',
  /** Maturing-data disclaimer (lib/metrics/maturity.ts): first day with complete stage history, and the day the notice retires. */
  historyCompleteSince: 'history_complete_since',
  disclaimerSunset: 'disclaimer_sunset',
  /** C1: the ONE business-wide reporting currency (CAD | USD) — dashboard, digests and AI context. */
  reportingCurrency: 'reporting_currency',
  /** C1: currency GHL opportunity (contract) values are entered in. */
  contractValueCurrency: 'contract_value_currency',
  // Legacy keys kept so the dormant write-back code still resolves them.
  ghlPipelineId: 'ghl_pipeline_id',
  ghlStageMap: 'ghl_stage_map',
  ghlCalendarMap: 'ghl_calendar_map',
  autoSyncEnabled: 'auto_sync_enabled',
  lastAutoSyncAt: 'last_auto_sync_at',
} as const;

export const DEFAULTS: Record<string, string> = {
  // F8 (2026-09-30): no silent America/New_York. The business timezone lives in settings (migration 0011 wrote
  // America/Edmonton); BUSINESS_TIMEZONE is only an explicit override for a database without the row.
  ...(process.env.BUSINESS_TIMEZONE?.trim() ? { [SETTING_KEYS.timezone]: process.env.BUSINESS_TIMEZONE.trim() } : {}),
  [SETTING_KEYS.autoSyncEnabled]: 'true',
  [SETTING_KEYS.summaryRecipientHistory]: '[]',
  [SETTING_KEYS.backfillFrom]: '2026-06-01',
  [SETTING_KEYS.metaBackfillFrom]: '2026-07-16',
  [SETTING_KEYS.historyCompleteSince]: '2026-09-01',
  [SETTING_KEYS.disclaimerSunset]: '2026-10-15',
  [SETTING_KEYS.reportingCurrency]: 'CAD',
  [SETTING_KEYS.contractValueCurrency]: 'CAD',
  // First sends go to Mitchell until recipients are changed on the Reports page.
  [SETTING_KEYS.digestRecipientsTodo]: 'mitchellgluck66@gmail.com',
  [SETTING_KEYS.digestRecipientsWeekly]: 'mitchellgluck66@gmail.com',
  [SETTING_KEYS.digestRecipientsMonthly]: 'mitchellgluck66@gmail.com',
  [SETTING_KEYS.digestEnabledTodo]: 'true',
  [SETTING_KEYS.digestEnabledWeekly]: 'true',
  [SETTING_KEYS.digestEnabledMonthly]: 'true',
};

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (rows.length > 0 && rows[0].value !== null) return rows[0].isSecret ? openSecret(rows[0].value) : rows[0].value;
  return DEFAULTS[key] ?? null;
}

export async function setSetting(
  key: string,
  value: string,
  options: { secret?: boolean } = {},
): Promise<void> {
  // Secrets are sealed before they touch the database; without a usable key in
  // production this throws (fail closed) rather than storing plaintext.
  const stored = options.secret ? sealSecret(value) : value;
  await db
    .insert(settings)
    .values({ key, value: stored, isSecret: options.secret ?? false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stored, isSecret: options.secret ?? false, updatedAt: new Date() },
    });
}

/**
 * Seal every secret row still stored in plaintext (rows saved before H4).
 * Runs after `npm run db:migrate` and as `npm run credentials:encrypt`; a
 * no-op without a key (local dev) or when everything is sealed. Idempotent.
 */
export async function encryptPlaintextSecrets(): Promise<{ sealed: number; skipped: string | null }> {
  const status = keyStatus();
  if (status.mode !== 'on') return { sealed: 0, skipped: status.mode };
  const plain = await db
    .select()
    .from(settings)
    .where(and(eq(settings.isSecret, true), ne(settings.value, ''), not(like(settings.value, `${ENC_PREFIX}%`))));
  for (const row of plain) {
    if (row.value === null) continue;
    await db.update(settings).set({ value: sealSecret(row.value, status), updatedAt: new Date() }).where(eq(settings.key, row.key));
  }
  return { sealed: plain.filter((r) => r.value !== null).length, skipped: null };
}

/** Every non-secret setting, with defaults filled in. Secrets are never included. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    if (row.isSecret) continue;
    if (row.value !== null) result[row.key] = row.value;
  }
  return result;
}

/** Thrown when no business timezone is configured — day boundaries are never guessed (F8, 2026-09-30). */
export class TimezoneNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`Business timezone is not configured — ${detail}. Set it in Setup (settings.timezone), e.g. America/Edmonton.`);
    this.name = 'TimezoneNotConfiguredError';
  }
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The business timezone: settings.timezone, else the BUSINESS_TIMEZONE env override. Neither → THROWS
 * (fail closed): every day boundary, week and digest depends on it, and a silent America/New_York default
 * moved last week's Applied from 14 to 21 in the 2026-09-29 verification.
 */
export async function getTimezone(): Promise<string> {
  const tz = (await getSetting(SETTING_KEYS.timezone))?.trim();
  if (!tz) throw new TimezoneNotConfiguredError('no settings.timezone row and no BUSINESS_TIMEZONE');
  if (!isValidTimezone(tz)) throw new TimezoneNotConfiguredError(`"${tz}" is not a valid IANA timezone`);
  return tz;
}

export async function rememberRecipient(email: string): Promise<void> {
  await setSetting(SETTING_KEYS.summaryRecipientEmail, email);
  const raw = (await getSetting(SETTING_KEYS.summaryRecipientHistory)) ?? '[]';
  let history: string[] = [];
  try {
    history = JSON.parse(raw) as string[];
  } catch {
    history = [];
  }
  const next = [email, ...history.filter((e) => e !== email)].slice(0, 5);
  await setSetting(SETTING_KEYS.summaryRecipientHistory, JSON.stringify(next));
}

export async function getRecipientHistory(): Promise<string[]> {
  const raw = (await getSetting(SETTING_KEYS.summaryRecipientHistory)) ?? '[]';
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/** Default backfill start dates, for fallbacks in the ingest modules. */
export const BACKFILL_DEFAULTS = {
  ghl: DEFAULTS[SETTING_KEYS.backfillFrom],
  meta: DEFAULTS[SETTING_KEYS.metaBackfillFrom],
} as const;
