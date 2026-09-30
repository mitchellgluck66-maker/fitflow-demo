/**
 * Payment ↔ contact identity join (normalised email / phone).
 * Manual matches (match_source='manual') are never overwritten by the sync.
 */

import { and, asc, eq, isNotNull, ne, or, isNull, sql } from 'drizzle-orm';
import { db, payments, contacts } from '@/db';
import { matchPayments } from '../metrics';

/**
 * Audit P1 #6 (2026-09-30): a refund row is written from Stripe's refund object, which carries no customer, so
 * refunds showed "—" for the customer and were counted as unmatched payments. A refund belongs to the charge it
 * reverses: it inherits the parent charge's customer, email, phone and contact (`match_source='parent'`).
 * Idempotent and self-repairing — it runs before every matching pass, so existing rows are fixed by the next sync.
 */
export async function inheritRefundParents(): Promise<{ updated: number }> {
  const rows = await db.execute(sql`
    update ${payments} r
    set contact_id = p.contact_id,
        email = coalesce(r.email, p.email),
        email_normalized = coalesce(r.email_normalized, p.email_normalized),
        phone_normalized = coalesce(r.phone_normalized, p.phone_normalized),
        customer_name = coalesce(r.customer_name, p.customer_name),
        match_source = case when p.contact_id is not null then 'parent' else r.match_source end,
        updated_at = now()
    from ${payments} p
    where r.kind = 'refund'
      and r.metadata->>'charge' = p.stripe_id
      and p.kind <> 'refund'
      and coalesce(r.match_source, '') <> 'manual'
      and (
        (p.contact_id is not null and r.contact_id is distinct from p.contact_id)
        or (r.customer_name is null and p.customer_name is not null)
        or (r.email is null and p.email is not null)
      )
    returning r.id`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as unknown[];
  return { updated: list.length };
}

export async function runPaymentMatching(): Promise<{ matched: number; unmatched: number }> {
  await inheritRefundParents();
  const candidates = await db
    .select({
      id: payments.id,
      emailNormalized: payments.emailNormalized,
      phoneNormalized: payments.phoneNormalized,
      contactId: payments.contactId,
      matchSource: payments.matchSource,
    })
    .from(payments)
    // Refunds are not matched on their own: they follow their parent charge (inheritRefundParents above).
    .where(and(eq(payments.origin, 'stripe'), ne(payments.kind, 'refund'), or(isNull(payments.matchSource), ne(payments.matchSource, 'manual'))));

  const people = await db
    .select({ id: contacts.id, emailNormalized: contacts.emailNormalized, phoneNormalized: contacts.phoneNormalized })
    .from(contacts)
    .where(or(isNotNull(contacts.emailNormalized), isNotNull(contacts.phoneNormalized)))
    // Deterministic: when two contacts share an email/phone, the same (oldest) one wins every run — no flip-flop.
    .orderBy(asc(contacts.createdAt), asc(contacts.id));

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
