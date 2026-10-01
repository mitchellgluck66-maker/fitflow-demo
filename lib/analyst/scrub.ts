/**
 * Fixture scrubbing (2026-10-01): a recorded replay fixture never holds real people. Before a fixture is
 * written, every person's name, email and phone is replaced with a stable placeholder — "Client A",
 * "Client B", … in order of first appearance, the same person the same placeholder everywhere in the
 * file (responses, log rows, tool results, the model's prose). PURE: the people come from the caller
 * (`loadPeople` reads the contacts table and the payments' customer names).
 *
 * What is replaced:
 *   - a full name ("Ravi Brown"), any case, anywhere;
 *   - a first or last name on its own (the model writes "Ravi booked…"), for people whose full name
 *     appears in the file — whole word, capitalised, and not an ordinary word (STOP: months, weekdays,
 *     "Will", "May", "Grant"…; such a name standing alone is left, and `findLeaks` does not count it);
 *   - every email address (known or not) and every known phone number / E.164-shaped number.
 * Ids and links (/clients/<id>) are not names and stay, so the replay still resolves them.
 *
 * `findLeaks` is the guard: the full names, emails and phones of EVERYONE in the people list, searched
 * in the final text. The recorder refuses to write a fixture with a leak, and the test suite fails on one.
 */

export interface Person {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

/** Ordinary words that are also given or family names: never replaced on their own. */
const STOP = new Set(
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday will grant mark rose joy hope faith grace summer autumn dawn april june august page bill rich art chase drew earl guy lane miles penny ray rob sky wade young long white black brown green gray grey king price day week month year paid organic client clients stage applied enrolled consult roadmap meta google facebook stripe total new old best worst cash spend'.split(
    ' ',
  ),
);
// A colour or a noun that is ALSO a very common surname is still a surname when it follows a first name — only the bare word is exempt.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const letters = (n: number): string => {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
};
const fullName = (p: Person) => `${p.firstName} ${p.lastName}`.replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');
/** Not inside a longer word; a preceding JSON escape (\n, \t…) does not count as a letter. */
const wordRe = (word: string, flags: string) => new RegExp(`(?:(?<![A-Za-zÀ-ÿ])|(?<=\\\\[nrtbf]))${escapeRe(word)}(?![A-Za-zÀ-ÿ])`, flags);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const E164 = /\+\d{10,15}\b/g;

export interface ScrubStats {
  people: number;
  names: number;
  emails: number;
  phones: number;
}

export interface Scrubber {
  scrub: (text: string) => string;
  stats: ScrubStats;
  /** placeholder → how many replacements (never the real name). */
  placeholders: string[];
}

/**
 * Build the replacements from the WHOLE text first (so placeholders are assigned by first appearance and
 * are the same in every string of the file), then apply them string by string.
 */
export function buildScrubber(people: Person[], wholeText: string): Scrubber {
  const lower = wholeText.toLowerCase();
  const present = people
    .map((p) => ({ p, name: fullName(p), at: fullName(p).length >= 3 ? lower.indexOf(fullName(p).toLowerCase()) : -1 }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  const byName = new Map<string, string>();
  for (const x of present) if (!byName.has(x.name.toLowerCase())) byName.set(x.name.toLowerCase(), `Client ${letters(byName.size)}`);

  // Full names, longest first (so "Ann Lee Smith" wins over "Ann Lee"); then bare first / last names of the people present.
  const full = [...byName.entries()].sort((a, b) => b[0].length - a[0].length).map(([name, ph]) => ({ re: new RegExp(escapeRe(name).replace(/ /g, '\\s+'), 'gi'), ph }));
  const tokens = new Map<string, string>();
  for (const x of present) {
    const ph = byName.get(x.name.toLowerCase())!;
    for (const t of [x.p.firstName.trim(), x.p.lastName.trim()]) {
      if (t.length < 3 || /\s/.test(t) || STOP.has(t.toLowerCase())) continue;
      const cap = t[0].toUpperCase() + t.slice(1);
      if (!tokens.has(cap)) tokens.set(cap, ph);
    }
  }
  const single = [...tokens.entries()].sort((a, b) => b[0].length - a[0].length).map(([t, ph]) => ({ re: wordRe(t, 'g'), ph }));

  const emailMap = new Map<string, string>();
  const phoneMap = new Map<string, string>();
  const knownPhones = [...new Set(people.map((p) => p.phone?.trim() ?? '').filter((p) => digits(p).length >= 10))].sort((a, b) => b.length - a.length);
  const stats: ScrubStats = { people: byName.size, names: 0, emails: 0, phones: 0 };
  const email = (e: string) => {
    const k = e.toLowerCase();
    // Letters only: a digit in a placeholder would read as a new number to the verifier.
    if (!emailMap.has(k)) emailMap.set(k, `client-${letters(emailMap.size).toLowerCase()}@example.invalid`);
    stats.emails += 1;
    return emailMap.get(k)!;
  };
  const phone = (p: string) => {
    const k = digits(p);
    if (!phoneMap.has(k)) phoneMap.set(k, `+1555${String(phoneMap.size + 1).padStart(7, '0')}`);
    stats.phones += 1;
    return phoneMap.get(k)!;
  };

  const scrub = (text: string): string => {
    let out = text.replace(EMAIL, (e) => (e.endsWith('@example.invalid') ? e : email(e)));
    for (const p of knownPhones) if (out.includes(p)) out = out.split(p).join(phone(p));
    out = out.replace(E164, (p) => (p.startsWith('+1555000') ? p : phone(p)));
    // The digits-only form too (the verifier quotes a number token without its "+"): same placeholder, without the "+".
    for (const p of knownPhones) {
      const d = digits(p);
      if (out.includes(d)) out = out.replace(new RegExp(`(?<!\\d)${d}(?!\\d)`, 'g'), () => phone(p).slice(1));
    }
    for (const { re, ph } of full)
      out = out.replace(re, () => {
        stats.names += 1;
        return ph;
      });
    for (const { re, ph } of single)
      out = out.replace(re, () => {
        stats.names += 1;
        return ph;
      });
    return out;
  };
  return { scrub, stats, placeholders: [...byName.values()] };
}

/**
 * Scrub every string of a JSON value. A string that is itself JSON (a log row's api_json, a tool_result's
 * content) is parsed, scrubbed structurally and re-serialised, so the same name is replaced identically
 * whether it sits in an object or inside an encoded string — the replay compares those byte for byte.
 */
export function scrubJson<T>(value: T, scrub: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const t = v.trimStart();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(v) as unknown;
          if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed));
        } catch {
          /* not JSON: a plain string */
        }
      }
      return scrub(v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export interface Leak {
  kind: 'name' | 'email' | 'phone';
  /** How many people's values were found — the values themselves are never put in a test message or a log. */
  count: number;
}

/** The guard: full names (any case), emails and phones of everyone in `people`, searched in `text`. */
export function findLeaks(text: string, people: Person[]): Leak[] {
  const lower = text.toLowerCase();
  let names = 0;
  let emails = 0;
  let phones = 0;
  for (const p of people) {
    const n = fullName(p);
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
