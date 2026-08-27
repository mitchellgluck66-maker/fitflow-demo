/**
 * Payment ↔ contact identity join (normalised email / phone).
 * Manual matches (match_source='manual') are never overwritten by the sync.
 */

import { and, eq, isNotNull, ne, or, isNull } from 'drizzle-orm';
import { db, payments, contacts } from '@/db';
import { matchPayments } from '../metrics';

export async function runPaymentMatching(): Promise<{ matched: number; unmatched: number }> {
  const candidates = await db
    .select({
      id: payments.id,
      emailNormalized: payments.emailNormalized,
      phoneNormalized: payments.phoneNormalized,
      contactId: payments.contactId,
      matchSource: payments.matchSource,
    })
    .from(payments)
    .where(and(eq(payments.origin, 'stripe'), or(isNull(payments.matchSource), ne(payments.matchSource, 'manual'))));

  const people = await db
    .select({ id: contacts.id, emailNormalized: contacts.emailNormalized, phoneNormalized: contacts.phoneNormalized })
    .from(contacts)
    .where(or(isNotNull(contacts.emailNormalized), isNotNull(contacts.phoneNormalized)));

  const matches = matchPayments(candidates, people);
  const now = new Date();
  for (const m of matches) {
    await db
      .update(payments)
      .set({ contactId: m.contactId, matchSource: 'auto', updatedAt: now })
      .where(and(eq(payments.id, m.paymentId), or(isNull(payments.matchSource), ne(payments.matchSource, 'manual'))));
  }

  const matchedIds = new Set(matches.map((m) => m.paymentId));
  const unmatched = candidates.filter((c) => !c.contactId && !matchedIds.has(c.id)).length;
  return { matched: matches.length, unmatched };
}

/** Human decision from Setup. `contactId=null` records "confirmed no match". */
export async function manualMatch(paymentId: string, contactId: string | null): Promise<boolean> {
  const [row] = await db
    .update(payments)
    .set({ contactId, matchSource: 'manual', updatedAt: new Date() })
    .where(eq(payments.id, paymentId))
    .returning({ id: payments.id });
  return Boolean(row);
}
