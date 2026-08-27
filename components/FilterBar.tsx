'use client';

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import type { TableState } from './tableState';
import { activeFilterCount } from './tableState';

export interface Facet {
  key: string;
  label: string;
  options: Array<{ value: string; label: string; count?: number }>;
}

/**
 * One filter bar for every table: instant text search (debounced into the
 * URL), toggleable chips grouped by facet (OR within, AND across), an
 * active-filter summary with "Clear all", and a "shown of total" count.
 */
export const FilterBar: React.FC<{
  state: TableState;
  facets: Facet[];
  onQ: (q: string) => void;
  onToggle: (key: string, value: string) => void;
  onClear: () => void;
  shown: number;
  total: number;
  placeholder?: string;
  noun?: string;
  className?: string;
  /** Extra controls rendered at the end of the search row (e.g. date inputs). */
  extra?: React.ReactNode;
}> = ({ state, facets, onQ, onToggle, onClear, shown, total, placeholder = 'Search…', noun = 'rows', className, extra }) => {
  const [q, setQ] = useState(state.q);
  // Re-sync the box when the URL changes underneath us (back button, Clear
  // all) — state adjusted during render, not in an effect.
  const [seenQ, setSeenQ] = useState(state.q);
  if (seenQ !== state.q) {
    setSeenQ(state.q);
    setQ(state.q);
  }
  useEffect(() => {
    if (q === state.q) return;
    const t = setTimeout(() => onQ(q), 150);
    return () => clearTimeout(t);
  }, [q, state.q, onQ]);

  const active = activeFilterCount(state);

  return (
    <div className={clsx('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={13} strokeWidth={2.2} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-quaternary)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label="Search"
            className="w-full h-8 pl-8 pr-7 text-[13px] rounded-[7px] focus-ring transition-all duration-150"
            style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQ('');
                onQ('');
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 grid place-items-center rounded-[4px] hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-quaternary)' }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {extra}
        <div className="flex-1" />
        <span className="text-[12px] tabular" style={{ color: 'var(--text-tertiary)' }}>
          {shown === total ? `${total.toLocaleString()} ${noun}` : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
        </span>
        {active > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-[6px] text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-ring"
            style={{ color: 'var(--accent)' }}
          >
            <X size={12} strokeWidth={2.4} /> Clear all ({active})
          </button>
        )}
      </div>

      {facets.some((f) => f.options.length > 0) && (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5">
          {facets
            .filter((f) => f.options.length > 0)
            .map((f) => {
              const selected = state.filters[f.key] ?? [];
              return (
                <div key={f.key} className="flex flex-wrap items-center gap-1" role="group" aria-label={f.label}>
                  <span className="text-[11px] font-semibold uppercase tracking-wide mr-0.5" style={{ color: 'var(--text-quaternary)' }}>
                    {f.label}
                  </span>
                  {f.options.map((o) => {
                    const on = selected.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onToggle(f.key, o.value)}
                        className="inline-flex items-center gap-1 h-[24px] px-2 rounded-full text-[11.5px] font-medium transition-all duration-150 focus-ring"
                        style={{
                          background: on ? 'var(--accent-muted)' : 'var(--surface-sunken)',
                          color: on ? 'var(--accent)' : 'var(--text-secondary)',
                          border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border-subtle)'}`,
                        }}
                      >
                        {o.label}
                        {o.count !== undefined && (
                          <span className="tabular" style={{ opacity: 0.65 }}>
                            {o.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};

/** Shared "nothing matches" state for filtered tables. */
export const NoMatches: React.FC<{ onClear: () => void; noun?: string }> = ({ onClear, noun = 'rows' }) => (
  <div className="flex flex-col items-center justify-center text-center py-10 px-6 rounded-[8px]" style={{ border: '1px dashed var(--border-subtle)' }}>
    <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
      No {noun} match these filters
    </p>
    <button type="button" onClick={onClear} className="mt-2 text-[12.5px] font-medium hover:underline focus-ring rounded" style={{ color: 'var(--accent)' }}>
      Clear filters
    </button>
  </div>
);
