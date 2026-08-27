/**
 * Demo dataset: idempotent, fully labelled, and the banner condition holds.
 * Runs against in-memory PGlite (vitest config blanks DATABASE_URL).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { seedDemo, type DemoSeedSummary } from '@/db/seed-demo';
import { clearDemoData, getDataProvenance } from '@/lib/provenance';

let first: DemoSeedSummary;

async function count(table: string, where = ''): Promise<number> {
  const res = await db.execute(sql.raw(`select count(*)::int as n from ${table} ${where}`));
  const rows = (res as unknown as { rows?: Array<{ n: number }> }).rows ?? (res as unknown as Array<{ n: number }>);
  return Number(rows[0].n);
}

beforeAll(async () => {
  first = await seedDemo();
}, 120_000);

describe('demo seed', () => {
  it('tells the whole story', async () => {
    expect(first.contacts).toBeGreaterThanOrEqual(190);
    expect(first.contacts).toBeLessThanOrEqual(215);
    expect(first.enrolled).toBeGreaterThanOrEqual(12);
    expect(first.recoveredNoShows).toBeGreaterThanOrEqual(6);
    expect(first.aiReports).toBe(4);
    expect(first.emailDigests).toBeGreaterThanOrEqual(15);

    expect(await count('payments', "where status = 'failed'")).toBe(2);
    expect(await count('payments', "where status = 'refunded'")).toBe(1);
    expect(await count('payments', "where kind = 'subscription' and status = 'active'")).toBe(3);
    expect(await count('payments', "where contact_id is null and status = 'succeeded'")).toBe(2);

    // Three campaigns, every day from June 16 → today.
    const days = await count('ad_spend', "where campaign_id = 'demo-fb-broad'");
    expect(await count('ad_spend', "where campaign_id = 'demo-fb-retarget'")).toBe(days);
    expect(await count('ad_spend', "where campaign_id = 'demo-google-brand'")).toBe(days);
    expect(days).toBeGreaterThanOrEqual(60);
    expect(await count('ad_spend', "where level = 'manual'")).toBe(0);

    // Insights for this_week / last_week / last_30_days + one narrative.
    expect(await count('ai_reports', "where kind = 'insight'")).toBe(3);
    expect(await count('ai_reports', "where kind = 'weekly_narrative'")).toBe(1);
    expect(await count('email_digests', "where kind = 'weekly'")).toBe(4);
    expect(await count('email_digests', "where status = 'skipped_empty'")).toBeGreaterThanOrEqual(1);
    expect(await count('sync_runs', "where trigger = 'demo'")).toBe(6);

    // Daily to-do has names: applicants from yesterday and 3 days ago.
    expect(await count('contacts', "where stage_id = 'demo-stage-applied'")).toBeGreaterThanOrEqual(4);
  });

  it('labels every row as demo where the column exists', async () => {
    for (const table of ['pipelines', 'stages', 'contacts', 'appointments', 'stage_transitions', 'ad_spend', 'payments']) {
      expect(await count(table, "where origin <> 'demo' or source <> 'demo'")).toBe(0);
    }
    expect(await count('ai_reports', "where content ->> 'demo' <> 'true'")).toBe(0);
    expect(await count('email_digests', "where subject not like '[demo] %'")).toBe(0);
    expect(await count('sync_runs', "where trigger <> 'demo'")).toBe(0);
  });

  it('shows the sample-data banner while demo rows exist', async () => {
    const prov = await getDataProvenance();
    expect(prov.hasDemoData).toBe(true);
    expect(prov.demoContacts).toBe(first.contacts);
    expect(prov.hasRealData).toBe(false);
  });

  it('is idempotent', async () => {
    const second = await seedDemo();
    expect(second).toEqual(first);
    expect(await count('contacts')).toBe(first.contacts);
    expect(await count('payments')).toBe(first.payments);
    expect(await count('ad_spend')).toBe(first.spendRows);
  }, 120_000);

  it('wipes cleanly and the banner goes away', async () => {
    const removed = await clearDemoData();
    expect(removed.contactsRemoved).toBe(first.contacts);
    expect(removed.paymentsRemoved).toBe(first.payments);
    expect(removed.aiReportsRemoved).toBe(4);
    for (const table of ['pipelines', 'stages', 'contacts', 'appointments', 'stage_transitions', 'ad_spend', 'payments', 'ai_reports', 'email_digests', 'sync_runs']) {
      expect(await count(table)).toBe(0);
    }
    expect((await getDataProvenance()).hasDemoData).toBe(false);
  });
});
