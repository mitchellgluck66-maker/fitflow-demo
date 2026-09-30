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
  if (CENTS.test(last) || CENTS.test(tail)) return 'cents';
  if (HOURS.test(last)) return 'hours';
  if (/^(pct|abs)$/.test(last)) return last === 'pct' ? 'ratio' : unitForPath(path.replace(/\.(pct|abs)$/, ''));
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

/** Walk one tool result's `data` and list every numeric (or null) leaf. */
export function ledgerEntries(ref: string, data: unknown, fetchedAt: string, currency: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === null) {
      out.push({ ref: `${ref}:${path}`, value: null, unit: unitForPath(path), fetchedAt, currency });
      return;
    }
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out.push({ ref: `${ref}:${path}`, value: v, unit: unitForPath(path), fetchedAt, currency });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`);
  };
  walk(data, 'data');
  return out;
}

export class Ledger {
  private entries = new Map<string, LedgerEntry>();

  add(ref: string, data: unknown, fetchedAt: string, currency: string): void {
    for (const e of ledgerEntries(ref, data, fetchedAt, currency)) this.entries.set(e.ref, e);
  }

  get(ref: string): LedgerEntry | undefined {
    return this.entries.get(ref.trim());
  }

  /** For `calculate`: the value, null when withheld, undefined when the ref is unknown. */
  resolve(ref: string): number | null | undefined {
    const e = this.get(ref);
    return e ? e.value : undefined;
  }

  size(): number {
    return this.entries.size;
  }
}
