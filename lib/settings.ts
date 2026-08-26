/**
 * Persisted app settings (key/value in SQLite).
 *
 * Used for anything that must survive a restart but isn't worth its own table -
 * most notably the remembered day-summary recipient, so staff type the address
 * once and it is pre-filled every day after.
 */

import { db, appSettings } from '@/db';
import { eq } from 'drizzle-orm';

export const SETTING_KEYS = {
  summaryRecipientEmail: 'summary_recipient_email',
  summaryRecipientHistory: 'summary_recipient_history',
  timezone: 'timezone',
  ghlPipelineId: 'ghl_pipeline_id',
  ghlStageMap: 'ghl_stage_map',
  ghlCalendarMap: 'ghl_calendar_map',
  autoSyncEnabled: 'auto_sync_enabled',
  lastAutoSyncAt: 'last_auto_sync_at',
} as const;

export const DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.timezone]: 'America/New_York',
  [SETTING_KEYS.autoSyncEnabled]: 'true',
  [SETTING_KEYS.summaryRecipientHistory]: '[]',
};

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);

  if (rows.length > 0 && rows[0].value !== null) return rows[0].value;
  return DEFAULTS[key] ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(appSettings)
      .set({ value, updatedAt: now })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value, updatedAt: now });
  }
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettings);
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    if (row.value !== null) result[row.key] = row.value;
  }
  return result;
}

export async function getTimezone(): Promise<string> {
  return (await getSetting(SETTING_KEYS.timezone)) ?? 'America/New_York';
}

/**
 * Remember a recipient address and keep a short history so the export dialog can
 * offer recent addresses as suggestions rather than only the single last one.
 */
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
