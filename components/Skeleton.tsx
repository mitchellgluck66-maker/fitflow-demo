'use client';

import React from 'react';
import clsx from 'clsx';

/**
 * Loading placeholders. Pages never show a full-page spinner: each async
 * section renders a skeleton with the same footprint as its content, so the
 * layout does not jump when data arrives. Uses the existing `.skeleton`
 * shimmer class from globals.css.
 */
export const Skeleton: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <div className={clsx('skeleton rounded-[6px]', className)} style={style} aria-hidden />
);

export const SkeletonText: React.FC<{ lines?: number; className?: string }> = ({ lines = 3, className }) => (
  <div className={clsx('space-y-2', className)} aria-hidden>
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} className="h-3" style={{ width: `${88 - (i % 3) * 14}%` }} />
    ))}
  </div>
);

/** Same footprint as a KPI tile. */
export const SkeletonTile: React.FC = () => (
  <div className="rounded-[12px] p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)' }} aria-hidden>
    <Skeleton className="h-3 w-24 mb-3" />
    <Skeleton className="h-7 w-28 mb-2" />
    <Skeleton className="h-3 w-36" />
  </div>
);

/** Same footprint as a table with N rows. */
export const SkeletonTable: React.FC<{ rows?: number; cols?: number }> = ({ rows = 6, cols = 5 }) => (
  <div className="space-y-2" aria-hidden>
    <div className="flex gap-3">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className="h-3 flex-1" />
      ))}
    </div>
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className="flex gap-3">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-4 flex-1" style={{ opacity: 1 - r * 0.08 }} />
        ))}
      </div>
    ))}
  </div>
);

/** Same footprint as a chart card body. */
export const SkeletonChart: React.FC<{ height?: number }> = ({ height = 230 }) => (
  <Skeleton className="w-full" style={{ height }} />
);
