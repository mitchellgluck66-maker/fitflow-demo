'use client';

import React from 'react';
import clsx from 'clsx';
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

export interface KPITileProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
  /** Whether an upward trend is good. Inverted for metrics like no-show rate. */
  trendIsGood?: boolean;
  icon?: LucideIcon;
  accent?: 'accent' | 'success' | 'warning' | 'danger' | 'info';
  sparkline?: number[];
  className?: string;
}

const ACCENTS = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
} as const;

/** Inline sparkline. Hand-rolled rather than pulling a chart lib into a tile. */
const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (data.length < 2) return null;

  const w = 68;
  const h = 22;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((value - min) / range) * (h - 3) - 1.5;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg width={w} height={h} className="overflow-visible shrink-0">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2.2" fill={color} />
    </svg>
  );
};

export const KPITile: React.FC<KPITileProps> = ({
  label,
  value,
  subtext,
  trend,
  trendValue,
  trendIsGood = true,
  icon: Icon,
  accent = 'accent',
  sparkline,
  className,
}) => {
  const accentColor = ACCENTS[accent];

  // "No change" is its own state. Treating a 0 delta as an up-trend paints a
  // green (or red) badge over what is actually flat, which misreads at a glance.
  const isFlat =
    trend === 'flat' ||
    (typeof trendValue === 'string' && /^[+-]?0(\D|$)/.test(trendValue.trim()));

  // A falling no-show rate is good news; colour follows meaning, not direction.
  const positive = isFlat
    ? null
    : trend === 'up'
      ? trendIsGood
      : trend === 'down'
        ? !trendIsGood
        : null;

  const trendColor =
    positive === null
      ? 'var(--text-tertiary)'
      : positive
        ? 'var(--success)'
        : 'var(--danger)';

  const TrendIcon = isFlat
    ? Minus
    : trend === 'up'
      ? TrendingUp
      : trend === 'down'
        ? TrendingDown
        : Minus;

  return (
    <div
      className={clsx(
        'surface-raised rounded-[12px] p-4 group transition-all duration-200',
        'hover:-translate-y-px hover:shadow-[var(--shadow-md)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && (
            <div
              className="h-[22px] w-[22px] grid place-items-center rounded-[6px] shrink-0 transition-transform duration-200 group-hover:scale-105"
              style={{
                background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
                color: accentColor,
              }}
            >
              <Icon size={12.5} strokeWidth={2.3} />
            </div>
          )}
          <span
            className="text-[11.5px] font-medium uppercase tracking-[0.045em] truncate"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {label}
          </span>
        </div>

        {sparkline && sparkline.length > 1 && (
          <Sparkline data={sparkline} color={accentColor} />
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div
            className="text-[26px] font-semibold leading-none tabular tracking-[-0.025em]"
            style={{ color: 'var(--text-primary)' }}
          >
            {value}
          </div>
          {subtext && (
            <div
              className="text-[11.5px] mt-1.5 truncate"
              style={{ color: 'var(--text-quaternary)' }}
            >
              {subtext}
            </div>
          )}
        </div>

        {trend && trendValue && (
          <div
            className="flex items-center gap-1 text-[11.5px] font-semibold shrink-0 px-1.5 py-1 rounded-[5px]"
            style={{
              color: trendColor,
              background: `color-mix(in srgb, ${trendColor} 10%, transparent)`,
            }}
          >
            <TrendIcon size={12} strokeWidth={2.5} />
            <span className="tabular">{trendValue}</span>
          </div>
        )}
      </div>
    </div>
  );
};
