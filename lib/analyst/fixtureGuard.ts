/**
 * Fixture guards (design review 2026-10-03, B). A replay fixture is recorded ONLY against the seeded demo
 * tenant, so it never holds customer data by construction. Two guards keep that true without any scrubbing:
 *
 *   - `nonDemoNames(fixture)`: every person-shaped string in the fixture's tool results (keys name,
 *     contactName, customerName, opportunityName; `missing` lists) must be a name the demo seed can
 *     generate. Runs in `npm run check` (the test database is the demo tenant too).
 *   - `findLeaks(text, people)`: the full names, emails and phones of a people list, searched in the text —
 *     `npm run check:fixtures` runs it against the REAL contacts table before a push (counts only).
 *   - `recordTenantCheck`: the recorder's refusal — a database URL, or any non-demo contact row, and
 *     nothing is recorded.
 */

import { DEMO_PEOPLE } from '../../db/seed-demo';
import type { ReplayFixture } from './replay';

export interface Person {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

const PERSON_KEYS = new Set(['name', 'contactName', 'customerName', 'opportunityName']);
const LIST_KEYS = new Set(['missing']);

/** Every person-shaped string in the fixture's tool results that the demo seed could not have produced. */
export function nonDemoNames(fixture: Pick<ReplayFixture, 'turns'>, allowed: ReadonlySet<string> = DEMO_PEOPLE.allNames()): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const check = (value: unknown, path: string) => {
    if (typeof value !== 'string' || !value.trim()) return;
    if (!allowed.has(value.trim())) out.push({ path, value });
  };
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = `${path}.${k}`;
      if (PERSON_KEYS.has(k)) check(x, p);
      else if (LIST_KEYS.has(k) && Array.isArray(x)) x.forEach((item, i) => check(typeof item === 'object' && item ? (item as { name?: unknown }).name : item, `${p}[${i}]`));
      else walk(x, p);
    }
  };
  for (const [ti, t] of fixture.turns.entries()) {
    for (const [ri, r] of t.rows.entries()) {
      if (r.role !== 'tool_results') continue;
      const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; content?: string; text?: string }> };
      for (const [bi, b] of (msg.content ?? []).entries()) {
        const json = b.type === 'tool_result' && typeof b.content === 'string' ? b.content : b.type === 'text' && typeof b.text === 'string' && b.text.includes('"ref":"r') ? b.text.slice(b.text.indexOf('{')) : null;
        if (!json) continue;
        try {
          walk((JSON.parse(json) as { data?: unknown }).data, `turns[${ti}].rows[${ri}].content[${bi}].data`);
        } catch {
          /* not a tool result */
        }
      }
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digits = (s: string) => s.replace(/\D/g, '');

export interface Leak {
  kind: 'name' | 'email' | 'phone';
  /** How many people's values were found — the values themselves are never put in a message or a log. */
  count: number;
}

/** Full names (any case), emails and phones of everyone in `people`, searched in `text`. */
export function findLeaks(text: string, people: Person[]): Leak[] {
  const lower = text.toLowerCase();
  let names = 0;
  let emails = 0;
  let phones = 0;
  for (const p of people) {
    const n = `${p.firstName} ${p.lastName}`.replace(/\s+/g, ' ').trim();
    if (n.length >= 5 && n.includes(' ') && new RegExp(escapeRe(n.toLowerCase()).replace(/ /g, '\\s+')).test(lower)) names += 1;
    if (p.email && p.email.includes('@') && lower.includes(p.email.toLowerCase())) emails += 1;
    const d = p.phone ? digits(p.phone) : '';
    if (d.length >= 10 && (text.includes(p.phone!.trim()) || text.includes(d))) phones += 1;
  }
  const out: Leak[] = [];
  if (names) out.push({ kind: 'name', count: names });
  if (emails) out.push({ kind: 'email', count: emails });
  if (phones) out.push({ kind: 'phone', count: phones });
  return out;
}

export function describeLeaks(leaks: Leak[]): string {
  return leaks.map((l) => `${l.count} ${l.kind}${l.count === 1 ? '' : 's'}`).join(', ');
}

/** The recorder's refusal, as a pure decision: only an embedded database holding nothing but demo rows may be recorded. */
export function recordTenantCheck(p: { databaseUrl: string | null; nonDemoContacts: number }): { ok: true } | { ok: false; reason: string } {
  if (p.databaseUrl) return { ok: false, reason: 'recording runs only against the demo tenant (an embedded database seeded by the smoke) — DATABASE_URL is set' };
  if (p.nonDemoContacts > 0) return { ok: false, reason: `recording runs only against the demo tenant — this database holds ${p.nonDemoContacts.toLocaleString('en-US')} non-demo contact${p.nonDemoContacts === 1 ? '' : 's'}` };
  return { ok: true };
}
