'use client';

import React, { useState } from 'react';
import clsx from 'clsx';
import { TrendingUp, TrendingDown, Minus, LineChart, type LucideIcon } from 'lucide-react';
import type { Delta } from '@/lib/metrics';
import { formatDelta } from '@/lib/metrics';
import { RadialRing } from './RadialRing';
import { KpiTrendPopover } from './KpiTrendPopover';

/**
 * KPI tile driven by an engine `Delta`. Same chrome as KPITile, plus a
 * tooltip that names the exact comparison dates and an explicit empty state
 * for metrics we do not have data for yet (never a fake number).
 *
 * With `trendMetric`, the tile is clickable: it opens the shared
 * KpiTrendPopover for that metric (daily 30d for volume/cash, weekly 12w for
 * rates/CAC). Enter/Space open it too; Esc or click-away closes.
 */
export const KpiDeltaTile: React.FC<{
  label: string;
  value: string;
  delta: Delta;
  deltaKind?: 'count' | 'cents' | 'pct' | 'ratio';
  /** e.g. "Jul 28 – Aug 26 vs Jun 28 – Jul 27" */
  comparisonLabel: string | null;
  subtext?: React.ReactNode;
  icon?: LucideIcon;
  accent?: 'accent' | 'success' | 'warning' | 'danger' | 'info';
  sparkline?: number[];
  /** 0..1 rate with a natural 0–100% frame — rendered as a radial ring instead of a sparkline. Never for counts/currency. */
  ring?: number | null;
  empty?: { title: string; description: string };
  /** Key in lib/metrics/trendMetrics — enables the click-to-trend popover. */
  trendMetric?: string;
  className?: string;
}> = ({ label, value, delta, deltaKind = 'count', comparisonLabel, subtext, icon: Icon, accent = 'accent', sparkline, ring, empty, trendMetric, className }) => {
  const [open, setOpen] = useState(false);
  const clickable = Boolean(trendMetric);
  const ACCENTS = {
    accent: 'var(--accent)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
    info: 'var(--info)',
  } as const;
  const color = ACCENTS[accent];

  const trendColor = delta.good === null ? 'var(--text-tertiary)' : delta.good ? 'var(--positive-text)' : 'var(--negative-text)';
  const trendBg = delta.good === null ? 'var(--surface-sunken)' : delta.good ? 'var(--positive-muted)' : 'var(--negative-muted)';
  const TrendIcon = delta.direction === 'up' ? TrendingUp : delta.direction === 'down' ? TrendingDown : Minus;

  return (
    <div
      className={clsx(
        'surface-raised rounded-[12px] p-4 group transition-all duration-200 hover:-translate-y-px hover:shadow-[var(--shadow-md)]',
        clickable && 'relative cursor-pointer focus-ring',
        // The open tile must sit above its siblings (each is its own stacking
        // context via the hover transform / stagger animation).
        open && 'z-[80]',
        className,
      )}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-haspopup={clickable ? 'dialog' : undefined}
      aria-expanded={clickable ? open : undefined}
      title={clickable ? `Show the trend for ${label}` : undefined}
      onClick={clickable ? () => setOpen((v) => !v) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen((v) => !v);
              }
            }
          : undefined
      }
    >
      {clickable && (
        <span
          className="absolute right-3 bottom-3 inline-flex items-center gap-1 text-[10.5px] font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{ color: 'var(--accent)' }}
          aria-hidden="true"
        >
          <LineChart size={11} strokeWidth={2.4} /> trend
        </span>
      )}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && (
            <div
              className="h-[22px] w-[22px] grid place-items-center rounded-[6px] shrink-0"
              style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
            >
              <Icon size={12.5} strokeWidth={2.3} />
            </div>
          )}
          <span className="text-[11.5px] font-medium uppercase tracking-[0.045em] truncate" style={{ color: 'var(--text-tertiary)' }}>
            {label}
          </span>
        </div>
        {!empty && delta.direction !== 'none' && (
          <span
            className="inline-flex items-center gap-1 h-[20px] px-1.5 rounded-[5px] text-[11px] font-semibold tabular cursor-help shrink-0"
            style={{ color: trendColor, background: trendBg }}
            title={comparisonLabel ? `${formatDelta(delta, deltaKind)} · ${comparisonLabel}` : formatDelta(delta, deltaKind)}
          >
            <TrendIcon size={11} strokeWidth={2.4} />
            {delta.pct !== null ? `${delta.pct > 0 ? '+' : delta.pct < 0 ? '−' : ''}${Math.abs(delta.pct * 100).toFixed(0)}%` : formatDelta(delta, deltaKind)}
          </span>
        )}
      </div>

      {empty ? (
        <div className="rounded-[8px] px-3 py-2.5" style={{ background: 'var(--surface-sunken)', border: '1px dashed var(--border-default)' }}>
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            {empty.title}
          </div>
          <div className="text-[11.5px] mt-0.5 leading-snug" style={{ color: 'var(--text-quaternary)' }}>
            {empty.description}
          </div>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[24px] font-semibold leading-none tracking-[-0.02em] tabular" style={{ color: 'var(--text-primary)' }}>
              {value}
            </div>
            {subtext && (
              <div className="text-[11.5px] mt-1.5 leading-snug" style={{ color: 'var(--text-quaternary)' }}>
                {subtext}
              </div>
            )}
          </div>
          {ring !== undefined ? <RadialRing value={ring} size={44} stroke={5} /> : sparkline && sparkline.length > 1 && <Spark data={sparkline} color={color} />}
        </div>
      )}
      {clickable && open && trendMetric && <KpiTrendPopover metric={trendMetric} label={label} onClose={() => setOpen(false)} />}
    </div>
  );
};

const Spark: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  const w = 68;
  const h = 22;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 3) - 1.5] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const id = `kspark-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={w} height={h} className="overflow-visible shrink-0">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill={color} />
    </svg>
  );
};
