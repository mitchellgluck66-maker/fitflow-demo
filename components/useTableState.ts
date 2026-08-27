'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  parseTableState,
  serializeTableState,
  toggleFilterValue,
  applyClient,
  type TableState,
  type SortDir,
  type ApplyOptions,
} from './tableState';

export { applyClient, facetOptions } from './tableState';
export type { TableState, SortDir, ApplyOptions } from './tableState';

/**
 * Table state (search, facets, sort, page) that lives in the URL so any
 * filtered view is shareable. `prefix` keeps two tables on one page apart.
 */
export function useTableState(options: { prefix?: string; facetKeys?: string[] } = {}) {
  const { prefix = '', facetKeys } = options;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const state = useMemo(() => parseTableState(params, prefix, facetKeys), [params, prefix, facetKeys]);

  const write = useCallback(
    (next: TableState) => {
      const q = serializeTableState(params, next, prefix, facetKeys);
      const qs = q.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, prefix, facetKeys, router],
  );

  const setQ = useCallback((q: string) => write({ ...state, q, page: 1 }), [state, write]);
  const toggleFilter = useCallback((key: string, value: string) => write(toggleFilterValue(state, key, value)), [state, write]);
  const setFilter = useCallback((key: string, values: string[]) => {
    const filters = { ...state.filters };
    if (values.length) filters[key] = values;
    else delete filters[key];
    write({ ...state, filters, page: 1 });
  }, [state, write]);
  const clearFilters = useCallback(() => write({ ...state, q: '', filters: {}, page: 1 }), [state, write]);
  const setSort = useCallback(
    (key: string, dir?: SortDir) => {
      const nextDir: SortDir = dir ?? (state.sort === key ? (state.dir === 'asc' ? 'desc' : 'asc') : 'desc');
      write({ ...state, sort: key, dir: nextDir });
    },
    [state, write],
  );
  const setPage = useCallback((page: number) => write({ ...state, page: Math.max(1, page) }), [state, write]);

  const apply = useCallback(<T,>(rows: T[], opts: ApplyOptions<T>) => applyClient(rows, state, opts), [state]);

  return { state, setQ, toggleFilter, setFilter, clearFilters, setSort, setPage, apply };
}
