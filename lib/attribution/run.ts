/**
 * DB side of attribution: recompute the auto class for every contact whose
 * class is not a manual override. Idempotent — only rows whose class or reason
 * would change are written. Runs from `npm run reclassify:attribution` and
 * after every GHL sync that touched contacts (the sync also computes it inline
 * for the rows it upserts; this pass catches rows the sync skipped).
 */

import { and, eq, ne } from 'drizzle-orm';
import { db, contacts, type AttributionClass } from '@/db';
import { classifyAttribution } from './classify';

export interface AttributionRunResult {
  scanned: number;
  paid: number;
  organic: number;
  manual: number;
  updated: number;
}

export async function runAttributionClassification(): Promise<AttributionRunResult> {
  const rows = await db
    .select({
      id: contacts.id,
      fbclid: contacts.fbclid,
      gclid: contacts.gclid,
      url: contacts.attributionUrl,
      utmSource: contacts.utmSource,
      utmMedium: contacts.utmMedium,
      source: contacts.attributionSource,
      sessionSource: contacts.sessionSource,
      attributionClass: contacts.attributionClass,
      attributionReason: contacts.attributionReason,
      attributionClassSource: contacts.attributionClassSource,
    })
    .from(contacts);

  const out: AttributionRunResult = { scanned: rows.length, paid: 0, organic: 0, manual: 0, updated: 0 };
  const now = new Date();
  for (const r of rows) {
    if (r.attributionClassSource === 'manual') {
      out.manual += 1;
      if (r.attributionClass === 'paid') out.paid += 1;
      else out.organic += 1;
      continue;
    }
    const c = classifyAttribution(r);
    if (c.attributionClass === 'paid') out.paid += 1;
    else out.organic += 1;
    if (r.attributionClass === c.attributionClass && r.attributionReason === c.reason) continue;
    await db
      .update(contacts)
      .set({ attributionClass: c.attributionClass, attributionReason: c.reason, attributionClassSource: 'auto', updatedAt: now })
      .where(and(eq(contacts.id, r.id), ne(contacts.attributionClassSource, 'manual')));
    out.updated += 1;
  }
  return out;
}

/**
 * Human override from the client profile. `null` clears the override and
 * restores the automatic class. Local to FitFlow — nothing is written to GHL.
 */
export async function setAttributionOverride(contactId: string, value: AttributionClass | null, note?: string): Promise<{ ok: boolean; attributionClass: AttributionClass | null; reason: string | null; source: string }> {
  const [row] = await db
    .select({
      fbclid: contacts.fbclid,
      gclid: contacts.gclid,
      url: contacts.attributionUrl,
      utmSource: contacts.utmSource,
      utmMedium: contacts.utmMedium,
      source: contacts.attributionSource,
      sessionSource: contacts.sessionSource,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) return { ok: false, attributionClass: null, reason: null, source: 'auto' };

  const auto = classifyAttribution(row);
  const next =
    value === null
      ? { attributionClass: auto.attributionClass, attributionReason: auto.reason, attributionClassSource: 'auto' as const }
      : {
          attributionClass: value,
          attributionReason: `manual override${note?.trim() ? `: ${note.trim()}` : ''} (auto would say ${auto.attributionClass} — ${auto.reason})`,
          attributionClassSource: 'manual' as const,
        };
  await db.update(contacts).set({ ...next, updatedAt: new Date() }).where(eq(contacts.id, contactId));
  return { ok: true, attributionClass: next.attributionClass, reason: next.attributionReason, source: next.attributionClassSource };
}
