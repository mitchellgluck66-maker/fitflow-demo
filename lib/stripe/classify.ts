/**
 * Payment class — new-client ("initial") vs recurring cash (Phase G, item 1).
 *
 * Rule (CLAUDE.md "Payment classes"):
 *   - Group charges by Stripe customer. Charges with no customer id fall back
 *     to the normalised email, then stand alone.
 *   - The customer's FIRST successful, not-fully-refunded charge is `initial`.
 *     "First" is by paid time; the payment rail does not matter, so a client
 *     whose first cash arrives as a subscription invoice still counts as a
 *     new client (otherwise subscription-only clients would never reach ROAS).
 *   - Every later successful charge — subscription invoices included — is
 *     `recurring`.
 *   - Failed, pending and fully refunded charges, refund rows and subscription
 *     plan rows are never cash, so they get NO class (null). The engine
 *     flags any succeeded cash that is still unclassed as a data-health
 *     warning rather than silently bucketing it.
 *
 * `classifyPayments` is pure and unit-tested; `runPaymentClassification` is
 * the DB wrapper that runs after every Stripe sync / webhook and from
 * `npm run reclassify:payments`. Re-running is idempotent: only rows whose
 * class would change are written.
 */

import { eq } from 'drizzle-orm';
import { db, payments, type PaymentClass } from '@/db';

export interface ClassifiablePayment {
  id: string;
  stripeCustomerId: string | null;
  emailNormalized: string | null;
  /** charge | invoice | subscription | refund */
  kind: string;
  /** succeeded | failed | refunded | pending | active … */
  status: string;
  amountCents: number;
  refundedCents: number;
  /** Epoch ms the cash landed; null for rows that never succeeded. */
  paidAtMs: number | null;
}

export interface PaymentClassification {
  id: string;
  paymentClass: PaymentClass | null;
}

const CASH_KINDS: ReadonlySet<string> = new Set(['charge', 'invoice']);

/** True when the row represents cash that actually stayed with the business. */
export function isCashPayment(p: { kind?: string | null; status: string; amountCents: number; refundedCents: number }): boolean {
  return CASH_KINDS.has(p.kind ?? 'charge') && p.status === 'succeeded' && p.refundedCents < p.amountCents;
}

export function customerKeyOf(p: { id: string; stripeCustomerId: string | null; emailNormalized: string | null }): string {
  if (p.stripeCustomerId) return `cus:${p.stripeCustomerId}`;
  if (p.emailNormalized) return `email:${p.emailNormalized}`;
  return `solo:${p.id}`;
}

export function classifyPayments(rows: ClassifiablePayment[]): PaymentClassification[] {
  const byCustomer = new Map<string, ClassifiablePayment[]>();
  for (const p of rows) {
    if (!isCashPayment(p)) continue;
    const key = customerKeyOf(p);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key)!.push(p);
  }

  const classOf = new Map<string, PaymentClass>();
  for (const list of byCustomer.values()) {
    const sorted = [...list].sort((a, b) => {
      const ta = a.paidAtMs ?? Number.POSITIVE_INFINITY;
      const tb = b.paidAtMs ?? Number.POSITIVE_INFINITY;
      return ta - tb || a.id.localeCompare(b.id);
    });
    sorted.forEach((p, i) => classOf.set(p.id, i === 0 ? 'initial' : 'recurring'));
  }

  return rows.map((p) => ({ id: p.id, paymentClass: classOf.get(p.id) ?? null }));
}

export interface ClassificationRunResult {
  scanned: number;
  initial: number;
  recurring: number;
  unclassed: number;
  /** Rows whose class changed this run. */
  updated: number;
}

/**
 * Classify every payment row in the database (all origins — demo rows are
 * classed too so demo mode renders the same split). Only rows whose class
 * differs from what is stored are written.
 */
export async function runPaymentClassification(): Promise<ClassificationRunResult> {
  const rows = await db
    .select({
      id: payments.id,
      stripeCustomerId: payments.stripeCustomerId,
      emailNormalized: payments.emailNormalized,
      kind: payments.kind,
      status: payments.status,
      amountCents: payments.amountCents,
      refundedCents: payments.refundedCents,
      paidAt: payments.paidAt,
      paymentClass: payments.paymentClass,
    })
    .from(payments);

  const result = classifyPayments(
    rows.map((r) => ({
      id: r.id,
      stripeCustomerId: r.stripeCustomerId,
      emailNormalized: r.emailNormalized,
      kind: r.kind,
      status: r.status,
      amountCents: r.amountCents,
      refundedCents: r.refundedCents,
      paidAtMs: r.paidAt ? r.paidAt.getTime() : null,
    })),
  );

  const stored = new Map(rows.map((r) => [r.id, r.paymentClass ?? null]));
  const out: ClassificationRunResult = { scanned: rows.length, initial: 0, recurring: 0, unclassed: 0, updated: 0 };
  const now = new Date();
  for (const r of result) {
    if (r.paymentClass === 'initial') out.initial += 1;
    else if (r.paymentClass === 'recurring') out.recurring += 1;
    else out.unclassed += 1;
    if (stored.get(r.id) === r.paymentClass) continue;
    await db.update(payments).set({ paymentClass: r.paymentClass, updatedAt: now }).where(eq(payments.id, r.id));
    out.updated += 1;
  }
  return out;
}
