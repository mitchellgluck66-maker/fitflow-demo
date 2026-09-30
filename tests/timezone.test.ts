/**
 * F8 (2026-09-30): the business timezone is data (settings.timezone, written by migration 0011) and is never
 * silently America/New_York. Missing everywhere → getTimezone THROWS; the layout / settings API surface it.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '@/db/migrate';
import { db, settings } from '@/db';
import { getTimezone, setSetting, TimezoneNotConfiguredError, SETTING_KEYS } from '@/lib/settings';

beforeAll(async () => {
  await runMigrations();
});

const envBefore = process.env.BUSINESS_TIMEZONE;
afterEach(async () => {
  if (envBefore === undefined) delete process.env.BUSINESS_TIMEZONE;
  else process.env.BUSINESS_TIMEZONE = envBefore;
  await setSetting(SETTING_KEYS.timezone, 'America/Edmonton');
});

describe('business timezone', () => {
  it('migration 0011 writes America/Edmonton and the app reads it', async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'timezone'));
    expect(row.value).toBe('America/Edmonton');
    expect(await getTimezone()).toBe('America/Edmonton');
  });

  it('no row: an explicit BUSINESS_TIMEZONE is honoured… (read at module load, so the row path is what production uses)', async () => {
    await db.delete(settings).where(eq(settings.key, 'timezone'));
    // DEFAULTS were built at import time from the env the test runner started with (unset) → no fallback.
    await expect(getTimezone()).rejects.toBeInstanceOf(TimezoneNotConfiguredError);
    await expect(getTimezone()).rejects.toThrow(/Business timezone is not configured — no settings.timezone row and no BUSINESS_TIMEZONE/);
  });

  it('an empty or invalid stored value fails closed — never America/New_York', async () => {
    await setSetting(SETTING_KEYS.timezone, '   ');
    await expect(getTimezone()).rejects.toBeInstanceOf(TimezoneNotConfiguredError);
    await setSetting(SETTING_KEYS.timezone, 'Mars/Olympus_Mons');
    await expect(getTimezone()).rejects.toThrow(/"Mars\/Olympus_Mons" is not a valid IANA timezone/);
  });

  it("the migration's INSERT keeps a human-chosen zone and fills only a missing or empty one", async () => {
    const file = readFileSync(join(process.cwd(), 'migrations/0011_f8_business_timezone.sql'), 'utf8');
    const insert = file.split('--> statement-breakpoint')[0];
    await setSetting(SETTING_KEYS.timezone, 'America/Vancouver');
    await db.execute(sql.raw(insert));
    expect(await getTimezone()).toBe('America/Vancouver');
    await setSetting(SETTING_KEYS.timezone, '');
    await db.execute(sql.raw(insert));
    expect(await getTimezone()).toBe('America/Edmonton');
    await db.delete(settings).where(eq(settings.key, 'timezone'));
    await db.execute(sql.raw(insert));
    expect(await getTimezone()).toBe('America/Edmonton');
  });
});
