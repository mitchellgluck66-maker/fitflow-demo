'use client';

import React from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import type { SortDir } from './tableState';
import { ExplainButton } from './analyst/ExplainButton';

/** A `<th>` that sorts on click and announces its state via aria-sort. */
export const SortableHeader: React.FC<{
  label: React.ReactNode;
  sortKey: string;
  activeKey: string | null;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  style?: React.CSSProperties;
  colSpan?: number;
  rowSpan?: number;
  /** "What does this mean?" (Wave 2 item 6): the column's glossary key — an icon beside the sort button. */
  explainKey?: string | null;
  explainLabel?: string;
}> = ({ label, sortKey, activeKey, dir, onSort, align = 'left', className, style, colSpan, rowSpan, explainKey, explainLabel }) => {
  const active = activeKey === sortKey;
  const Icon = active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      colSpan={colSpan}
      rowSpan={rowSpan}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={clsx('px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap select-none explain-host', align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left', className)}
      style={{ color: active ? 'var(--accent)' : 'var(--text-quaternary)', ...style }}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={clsx('inline-flex items-center gap-1 rounded-[4px] px-1 -mx-1 transition-colors hover:bg-[var(--surface-hover)] focus-ring', align === 'right' && 'flex-row-reverse')}
        style={{ color: 'inherit' }}
        title={`Sort by ${typeof label === 'string' ? label : sortKey}`}
      >
        {label}
        <Icon size={11} strokeWidth={2.4} style={{ opacity: active ? 1 : 0.55 }} />
      </button>
      {explainKey && <ExplainButton metricKey={explainKey} label={explainLabel ?? (typeof label === 'string' ? label : sortKey)} variant="icon" className="ml-0.5 normal-case" />}
    </th>
  );
};
