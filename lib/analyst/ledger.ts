/**
 * The ref ledger (plan item 6) — PURE. Every numeric leaf of every tool result in a thread, addressed as
 * `<call ref>:data.<json path>` (arrays by index: `data.stages[2].count`). Rebuilt from the STORED
 * tool-result rows, so compaction can never lose a ref; `calculate` resolves its operands through it and
 * the renderer prints every number the owner reads from it (design review 2026-10-03, A).
 *
 * Each entry carries what the renderer and the checks need: the unit (`lib/analyst/units.ts` — a contract,
 * never a guess), the reading of a ratio (% or ×), the result's currency, whether the value is a DELTA
 * (a comparison's pct / abs, or a row declaring `delta: true`), and the metric it belongs to (the row's
 * `kpi` / `metric` field, or the `kpis.<metric>` parent) — the direction check reads those.
 */

import { DECLARED_UNITS, resolveUnit, type DeclaredUnit, type LedgerUnit, type Reading } from './units';

export type { LedgerUnit } from './units';

export interface LedgerEntry {
  ref: string;
  value: number | null;
  unit: LedgerUnit;
  /** For a ratio: shown as a percentage (`pct`) or a multiple (`multiple`); null for other units. */
  reading: Reading;
  /** ISO time the tool result was produced (stale-ref check). */
  fetchedAt: string;
  /** The result's currency (for cents). */
  currency: string;
  /** A change between two values (sign matters for the direction check). */
  delta: boolean;
  /** The metric key this value belongs to, when the result names one (kpis.<key>, a row's `kpi` / `metric`). */
  metric: string | null;
}

/** The `unit` an object declares (valid names only), or the inherited one. */
export function declaredUnit(obj: unknown, inherited: DeclaredUnit | null): DeclaredUnit | null {
  const u = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>).unit : undefined;
  return typeof u === 'string' && DECLARED_UNITS.has(u) ? (u as DeclaredUnit) : inherited;
}

/** The metric an object names (`kpi` or `metric` string), or the inherited one. */
function declaredMetric(obj: unknown, inherited: string | null): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return inherited;
  const o = obj as Record<string, unknown>;
  const m = typeof o.kpi === 'string' ? o.kpi : typeof o.metric === 'string' ? o.metric : null;
  return m ?? inherited;
}

/** The unit of the leaf at `path` given the nearest declared unit — `resolveUnit` with the ledger's vocabulary. */
export function leafUnit(path: string, declared: DeclaredUnit | null): LedgerUnit {
  return resolveUnit(path, declared).unit;
}

/** Back-compat for callers that only have a path. */
export function unitForPath(path: string): LedgerUnit {
  return resolveUnit(path, null).unit;
}

const lastKey = (path: string) => (path.split(/[.[]/).filter(Boolean).pop() ?? '').replace(/\]$/, '');

/** Walk one tool result's `data` and list every numeric (or null) leaf. */
export function ledgerEntries(ref: string, data: unknown, fetchedAt: string, currency: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const push = (path: string, value: number | null, declared: DeclaredUnit | null, metric: string | null, deltaRow: boolean) => {
    const r = resolveUnit(path, declared);
    const key = lastKey(path);
    const segs = path.split(/[.[]/).filter(Boolean).map((s) => s.replace(/\]$/, ''));
    const parent = segs[segs.length - 2];
    const grand = segs[segs.length - 3];
    out.push({
      ref: `${ref}:${path}`,
      value,
      unit: r.unit,
      reading: r.reading,
      fetchedAt,
      currency,
      delta: deltaRow || key === 'pct' || key === 'abs',
      metric: metric ?? (grand === 'kpis' && parent ? parent : null),
    });
  };
  const walk = (v: unknown, path: string, declared: DeclaredUnit | null, metric: string | null, deltaRow: boolean) => {
    if (v === null) return push(path, null, declared, metric, deltaRow);
    if (typeof v === 'number') return Number.isFinite(v) ? push(path, v, declared, metric, deltaRow) : undefined;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, declared, metric, deltaRow));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const d = declaredUnit(v, declared);
      const m = declaredMetric(v, metric);
      const isDelta = o.delta === true || deltaRow;
      for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`, d, m, isDelta);
    }
  };
  walk(data, 'data', null, null, false);
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

  /** For `calculate`: the unit and currency the renderer will hold this ref to (hours and unknown are plain numbers there). */
  info(ref: string): { unit: 'cents' | 'count' | 'ratio' | 'number'; currency: string | null; metric: string | null; delta: boolean } | undefined {
    const e = this.get(ref);
    return e ? { unit: e.unit === 'hours' || e.unit === 'unknown' ? 'number' : e.unit, currency: e.currency ?? null, metric: e.metric, delta: e.delta } : undefined;
  }

  size(): number {
    return this.entries.size;
  }
}
