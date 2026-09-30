/**
 * First-run repair (F3, 2026-09-30): fill every existing contact's EMPTY utm_* / fbclid / gclid from its stored
 * attribution_url, then re-run attribution classification (manual overrides untouched). The app repairs its own
 * data: a dispatch step runs this until it has completed once for UTM_BACKFILL_VERSION, then reports "done".
 * New and changed contacts are filled at sync time (lib/ghl/ingest.ts) from then on.
 */
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db, contacts } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';
import { fillFromUrl, type UrlParams } from './utm';
import { runAttributionClassification } from './run';

export const UTM_BACKFILL_VERSION = 'v1';

export interface UtmBackfillResult {
  ok: boolean;
  skipped?: string;
  scanned: number;
  filledContacts: number;
  filledFields: Partial<Record<keyof UrlParams, number>>;
  reclassified: number;
}

export async function runUtmBackfill(opts: { force?: boolean } = {}): Promise<UtmBackfillResult> {
  const out: UtmBackfillResult = { ok: true, scanned: 0, filledContacts: 0, filledFields: {}, reclassified: 0 };
  const done = await getSetting(SETTING_KEYS.utmBackfill);
  if (!opts.force && done) {
    try {
      const d = JSON.parse(done) as { version?: string; at?: string; filledContacts?: number };
      if (d.version === UTM_BACKFILL_VERSION) return { ...out, skipped: `utm backfill ${UTM_BACKFILL_VERSION} already done ${d.at} (${d.filledContacts} contacts filled) — new contacts are filled at sync` };
    } catch {
      /* re-run */
    }
  }
  const rows = await db
    .select({ id: contacts.id, url: contacts.attributionUrl, utmSource: contacts.utmSource, utmMedium: contacts.utmMedium, utmCampaign: contacts.utmCampaign, utmContent: contacts.utmContent, utmTerm: contacts.utmTerm, fbclid: contacts.fbclid, gclid: contacts.gclid })
    .from(contacts)
    .where(and(isNotNull(contacts.attributionUrl), ne(contacts.origin, 'demo')));
  const now = new Date();
  for (const r of rows) {
    out.scanned += 1;
    const { values, filled } = fillFromUrl(r, r.url);
    if (filled.length === 0) continue;
    const set: Partial<UrlParams> & { updatedAt: Date } = { updatedAt: now };
    for (const k of filled) {
      set[k] = values[k];
      out.filledFields[k] = (out.filledFields[k] ?? 0) + 1;
    }
    await db.update(contacts).set(set).where(eq(contacts.id, r.id));
    out.filledContacts += 1;
  }
  out.reclassified = (await runAttributionClassification()).updated;
  await setSetting(SETTING_KEYS.utmBackfill, JSON.stringify({ version: UTM_BACKFILL_VERSION, at: now.toISOString(), scanned: out.scanned, filledContacts: out.filledContacts, filledFields: out.filledFields, reclassified: out.reclassified }));
  return out;
}
