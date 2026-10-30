/**
 * Companion stage 5 — stop side-effect emails to clients (docs/plan-companion-stage5.md).
 *   item 1: the Reschedule default is 'leave'; migration 0024 writes the row only when none exists and keeps an
 *           owner's 'cancelled'.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, settings } from '@/db';
import { getSetting } from '@/lib/settings';
import { COMPANION_SETTING_KEYS, readRescheduleAppointment } from '@/lib/companion/config';

const KEY = COMPANION_SETTING_KEYS.rescheduleAppointment;

async function replay0024() {
  const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '0024_companion_reschedule_leave.sql'), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await db.execute(stmt);
}

beforeAll(async () => {
  await runMigrations();
});

describe('item 1 — reschedule never cancels', () => {
  it('a fresh database carries the explicit leave row after the migrations; the catalogue reads leave', async () => {
    expect(await getSetting(KEY)).toBe('leave');
    expect(await readRescheduleAppointment()).toBe('leave');
  });

  it('0024: no row → leave written; an owner\'s cancelled → kept; leave → unchanged', async () => {
    await db.delete(settings).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('leave');

    await db.update(settings).set({ value: 'cancelled' }).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('cancelled');
    expect(await readRescheduleAppointment()).toBe('cancelled');

    await db.update(settings).set({ value: 'leave' }).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('leave');
  });
});
