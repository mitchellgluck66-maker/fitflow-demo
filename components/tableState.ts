/**
 * Pure table-state helpers (no React) shared by the useTableState hook and
 * the tests. State = { q, sort, dir, filters, page } serialised into the URL
 * query string next to the date picker's range/start/end/compare, with an
 * optional prefix so two tables on one page do not collide (`c_q`, `p_q`).
 */

export type SortDir = 'asc' | 'desc';

export interface TableState {
  q: string;
  sort: string | null;
  dir: SortDir;
  /** facet key → selected values (OR within a facet, AND across facets). */
  filters: Record<string, string[]>;
  page: number;
}

export const EMPTY_TABLE_STATE: TableState = { q: '', sort: null, dir: 'desc', filters: {}, page: 1 };

const RESERVED = new Set(['q', 'sort', 'dir', 'page']);

/** Keys that belong to the global date picker and must never be treated as facets. */
const GLOBAL_KEYS = new Set(['range', 'start', 'end', 'compare']);

export function parseTableState(params: URLSearchParams, prefix = '', facetKeys?: string[]): TableState {
  const get = (k: string) => params.get(`${prefix}${k}`);
  const filters: Record<string, string[]> = {};
  if (facetKeys) {
    for (const key of facetKeys) {
      const raw = get(key);
      if (raw) filters[key] = raw.split(',').map((v) => decodeURIComponent(v)).filter(Boolean);
    }
  } else {
    for (const [k, v] of params.entries()) {
      if (!k.startsWith(prefix)) continue;
      const key = k.slice(prefix.length);
      if (RESERVED.has(key) || GLOBAL_KEYS.has(key) || !v) continue;
      filters[key] = v.split(',').map((x) => decodeURIComponent(x)).filter(Boolean);
    }
  }
  const dir = get('dir');
  const page = Number(get('page') ?? 1);
  return {
    q: get('q') ?? '',
    sort: get('sort') || null,
    dir: dir === 'asc' ? 'asc' : 'desc',
    filters,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** Write a state onto a copy of the params, deleting keys at their defaults. */
export function serializeTableState(params: URLSearchParams, state: TableState, prefix = '', facetKeys?: string[]): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  const set = (k: string, v: string | null) => {
    if (v === null || v === '') next.delete(`${prefix}${k}`);
    else next.set(`${prefix}${k}`, v);
  };
  set('q', state.q.trim() || null);
  set('sort', state.sort);
  set('dir', state.sort ? (state.dir === 'asc' ? 'asc' : null) : null);
  set('page', state.page > 1 ? String(state.page) : null);
  // Clear every facet key we know about, then re-add the active ones.
  const known = new Set([...(facetKeys ?? []), ...Object.keys(state.filters)]);
  if (!facetKeys) {
    for (const k of Array.from(next.keys())) {
      if (k.startsWith(prefix)) {
        const key = k.slice(prefix.length);
        if (!RESERVED.has(key) && !GLOBAL_KEYS.has(key)) known.add(key);
      }
    }
  }
  for (const key of known) {
    const values = state.filters[key] ?? [];
    set(key, values.length ? values.map((v) => encodeURIComponent(v)).join(',') : null);
  }
  return next;
}

export function toggleFilterValue(state: TableState, key: string, value: string): TableState {
  const current = state.filters[key] ?? [];
  const values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const filters = { ...state.filters };
  if (values.length) filters[key] = values;
  else delete filters[key];
  return { ...state, filters, page: 1 };
}

export function activeFilterCount(state: TableState): number {
  return Object.values(state.filters).reduce((n, v) => n + v.length, 0) + (state.q.trim() ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Client-side application (text search + facets + sort)
// ---------------------------------------------------------------------------

export type Accessor<T> = (row: T) => string | number | null | undefined;

export interface ApplyOptions<T> {
  /** Fields the text search looks through. */
  search: Accessor<T>[];
  /** facet key → value(s) a row belongs to. */
  facets: Record<string, (row: T) => string | string[] | null | undefined>;
  /** sort key → accessor. */
  sorts: Record<string, Accessor<T>>;
  /** Default sort when state.sort is null. */
  defaultSort?: { key: string; dir: SortDir };
}

function matchesFacets<T>(row: T, state: TableState, facets: ApplyOptions<T>['facets']): boolean {
  for (const [key, wanted] of Object.entries(state.filters)) {
    if (!wanted.length) continue;
    const getter = facets[key];
    if (!getter) continue; // unknown facet keys are ignored, not fatal
    const raw = getter(row);
    const have = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (!have.some((v) => wanted.includes(v))) return false;
  }
  return true;
}

function matchesText<T>(row: T, q: string, search: Accessor<T>[]): boolean {
  if (!q) return true;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = search
    .map((a) => a(row))
    .filter((v) => v !== null && v !== undefined)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Nulls always sort last regardless of direction. */
export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  const an = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  let c: number;
  if (typeof a === 'number' && typeof b === 'number') c = a - b;
  else c = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? c : -c;
}

export function applyClient<T>(rows: T[], state: TableState, opts: ApplyOptions<T>): T[] {
  const q = state.q.trim();
  const out = rows.filter((r) => matchesText(r, q, opts.search) && matchesFacets(r, state, opts.facets));
  const sortKey = state.sort ?? opts.defaultSort?.key ?? null;
  const dir = state.sort ? state.dir : (opts.defaultSort?.dir ?? 'desc');
  const accessor = sortKey ? opts.sorts[sortKey] : undefined;
  if (accessor) {
    // Stable sort: decorate with the original index.
    return out
      .map((row, i) => ({ row, i }))
      .sort((x, y) => compareValues(accessor(x.row), accessor(y.row), dir) || x.i - y.i)
      .map((x) => x.row);
  }
  return out;
}

/** Facet options with counts, derived from the rows (before facet filtering). */
export function facetOptions<T>(rows: T[], getter: (row: T) => string | string[] | null | undefined, label?: (v: string) => string): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = getter(r);
    const vals = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: label ? label(value) : value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
