/**
 * The ref ledger (plan item 6) — PURE. Every numeric leaf of every tool
 * result in a thread, addressed as `<call ref>:data.<json path>` (arrays by
 * index: `data.stages[2].count`). Rebuilt from the STORED tool-result rows,
 * so compaction can never lose a ref, and `calculate` resolves its operands
 * through it. A unit is inferred from the path so the verifier knows how a
 * value may be rendered (cents → dollars, ratio → percent, count → exact).
 */

export type LedgerUnit = 'cents' | 'ratio' | 'count' | 'number' | 'hours';

export interface LedgerEntry {
  ref: string;
  value: number | null;
  unit: LedgerUnit;
  /** ISO time the tool result was produced (stale-ref check). */
  fetchedAt: string;
  /** The result's currency (for cents). */
  currency: string;
}

const RATIO = /(rate|roas|pct|share|conversion(From)?|ltvToCac|coverage)/i;
const CENTS = /cents/i;
const HOURS = /hours/i;
const COUNT = /(count|enrollments|applied|booked|showed|enrolled|impressions|reach|clicks|views|leads|purchases|total|pages|page|samples|failed|unmatched|rows|day|days)/i;

export function unitForPath(path: string): LedgerUnit {
  const last = path.split(/[.[]/).filter(Boolean).pop() ?? '';
  const tail = path.split('.').slice(-2).join('.');
  // A delta's `pct` is a ratio whatever its parent (kpis.paidCacCents.pct — item 3 found it read as cents); `abs` keeps the parent's unit.
  if (/^(pct|abs)$/.test(last)) return last === 'pct' ? 'ratio' : unitForPath(path.replace(/\.(pct|abs)$/, ''));
  if (CENTS.test(last) || CENTS.test(tail)) return 'cents';
  if (HOURS.test(last)) return 'hours';
  if (RATIO.test(last)) return 'ratio';
  if (/^(current|previous|against|value|spanValue|previousSpanValue)$/.test(last)) {
    // Inherit from the parent: kpis.paidCacCents.current → cents; kpis.roas.current → ratio.
    const parent = path.replace(/\.[^.]+$/, '');
    const p = parent.split(/[.[]/).filter(Boolean).pop() ?? '';
    if (CENTS.test(p)) return 'cents';
    if (RATIO.test(p)) return 'ratio';
    if (COUNT.test(p)) return 'count';
    return 'number';
  }
  if (COUNT.test(last)) return 'count';
  return 'number';
}

/**
 * Explicit units (2026-10-01, the "$4,937.50 CAD" vs results[16].value = 493750 false flag). A path cannot
 * tell what `results[16].value`, `kpis[3].current` or a trend point's `value` measures, so the object that
 * holds such a number — or the nearest ancestor — says so with a `unit` field, and it applies to the
 * generic value keys below. `pct` (a 0–1 share shown as %) and `ratio` / `multiple` (shown as ×) are both
 * the ledger's `ratio`. A name-derived unit (spendCents, rate, count…) always wins over the inherited one.
 */
const EXPLICIT_UNITS: Record<string, LedgerUnit> = { cents: 'cents', count: 'count', ratio: 'ratio', multiple: 'ratio', pct: 'ratio', hours: 'hours', number: 'number' };
const GENERIC_VALUE_KEYS = /^(value|current|previous|against|abs|baseline|spanValue|previousSpanValue)$/;

/** The `unit` an object declares for its generic value keys (and its descendants'), or the inherited one. */
export function declaredUnit(obj: unknown, inherited: string | null): string | null {
  const u = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>).unit : undefined;
  return typeof u === 'string' && u in EXPLICIT_UNITS ? u : inherited;
}

/** The unit of the leaf at `path`: the name-derived unit, else the declared one for a generic value key. */
export function leafUnit(path: string, declared: string | null): LedgerUnit {
  const byName = unitForPath(path);
  if (byName !== 'number' || !declared) return byName;
  const last = path.split(/[.[]/).filter(Boolean).pop() ?? '';
  return GENERIC_VALUE_KEYS.test(last) ? EXPLICIT_UNITS[declared] : byName;
}

/** Walk one tool result's `data` and list every numeric (or null) leaf. */
export function ledgerEntries(ref: string, data: unknown, fetchedAt: string, currency: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const walk = (v: unknown, path: string, declared: string | null) => {
    if (v === null) {
      out.push({ ref: `${ref}:${path}`, value: null, unit: leafUnit(path, declared), fetchedAt, currency });
      return;
    }
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out.push({ ref: `${ref}:${path}`, value: v, unit: leafUnit(path, declared), fetchedAt, currency });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, declared));
      return;
    }
    if (v && typeof v === 'object') {
      const d = declaredUnit(v, declared);
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, d);
    }
  };
  walk(data, 'data', null);
  return out;
}

export class Ledger {
  private entries = new Map<string, LedgerEntry>();

  add(ref: string, data: unknown, fetchedAt: string, currency: string): void {
    for (const e of ledgerEntries(ref, data, fetchedAt, currency)) this.entries.set(e.ref, e);
  }

  get(ref: string): LedgerEntry | undefined {
    const key = ref.trim();
    // A ref to a display string (`…spendCentsText`) means the number beside it (item 3).
    return this.entries.get(key) ?? (key.endsWith('Text') ? this.entries.get(key.slice(0, -4)) : undefined);
  }

  /** For `calculate`: the value, null when withheld, undefined when the ref is unknown. */
  resolve(ref: string): number | null | undefined {
    const e = this.get(ref);
    return e ? e.value : undefined;
  }

  /** For `calculate`: the unit and currency the verifier will hold this ref to (hours are plain numbers there). */
  info(ref: string): { unit: 'cents' | 'count' | 'ratio' | 'number'; currency: string | null } | undefined {
    const e = this.get(ref);
    return e ? { unit: e.unit === 'hours' ? 'number' : e.unit, currency: e.currency ?? null } : undefined;
  }

  size(): number {
    return this.entries.size;
  }
}
