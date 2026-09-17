/**
 * Persisted app settings (key/value in the `settings` table).
 *
 * Credentials live here too (entered in /setup, verified on save). Rows flagged
 * `isSecret` are never returned unmasked by any API route — see
 * lib/ghl/config.ts#maskToken. Env vars are the fallback when nothing is stored.
 */

import { db, settings } from '@/db';
import { eq } from 'drizzle-orm';

export const SETTING_KEYS = {
  timezone: 'timezone',
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
  // Legacy keys kept so the dormant write-back code still resolves them.
  ghlPipelineId: 'ghl_pipeline_id',
  ghlStageMap: 'ghl_stage_map',
  ghlCalendarMap: 'ghl_calendar_map',
  autoSyncEnabled: 'auto_sync_enabled',
  lastAutoSyncAt: 'last_auto_sync_at',
} as const;

export const DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.timezone]: process.env.BUSINESS_TIMEZONE?.trim() || 'America/New_York',
  [SETTING_KEYS.autoSyncEnabled]: 'true',
  [SETTING_KEYS.summaryRecipientHistory]: '[]',
  [SETTING_KEYS.backfillFrom]: '2026-06-01',
  [SETTING_KEYS.metaBackfillFrom]: '2026-07-16',
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
  if (rows.length > 0 && rows[0].value !== null) return rows[0].value;
  return DEFAULTS[key] ?? null;
}

export async function setSetting(
  key: string,
  value: string,
  options: { secret?: boolean } = {},
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, isSecret: options.secret ?? false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, isSecret: options.secret ?? false, updatedAt: new Date() },
    });
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

export async function getTimezone(): Promise<string> {
  return (await getSetting(SETTING_KEYS.timezone)) ?? 'America/New_York';
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
