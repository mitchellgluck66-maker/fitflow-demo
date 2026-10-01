/**
 * The people a recorded fixture must not contain: every contact (name, email, phone) and every Stripe
 * customer name / email on a payment. Read-only; used by `smoke:analyst -- --record`, the fixture test
 * and `npm run check:fixtures`.
 */
import { db, contacts, payments } from '@/db';
import type { Person } from './scrub';

export async function loadPeople(): Promise<Person[]> {
  const [cs, ps] = await Promise.all([
    db.select({ firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone }).from(contacts),
    db.select({ name: payments.customerName, email: payments.email }).from(payments),
  ]);
  const out: Person[] = cs.map((c) => ({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', email: c.email, phone: c.phone }));
  const seen = new Set<string>();
  for (const p of ps) {
    const name = (p.name ?? '').replace(/\s+/g, ' ').trim();
    const key = `${name.toLowerCase()}|${(p.email ?? '').toLowerCase()}`;
    if ((!name && !p.email) || seen.has(key)) continue;
    seen.add(key);
    const [first, ...rest] = name.split(' ');
    out.push({ firstName: first ?? '', lastName: rest.join(' '), email: p.email, phone: null });
  }
  return out;
}
