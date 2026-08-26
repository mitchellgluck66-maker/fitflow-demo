'use client';

import React from 'react';

/**
 * Shared chart chrome.
 *
 * Recharts ships light-mode defaults baked into inline styles, so tooltips and
 * legends need to be replaced rather than restyled. Centralising them here is
 * what keeps every chart in the app looking like it came from the same hand.
 */

export const CHART_COLORS = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
} as const;

/** Categorical palette for pies and multi-series charts. Purple-led, then
 *  spaced around the wheel so adjacent slices stay distinguishable. */
export const CATEGORICAL = [
  '#8f66ff',
  '#22b8a0',
  '#f5a524',
  '#4d9bff',
  '#ff6b9d',
  '#3fcf8e',
  '#ff8f5e',
  '#a78bfa',
];

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

export const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  suffix?: string;
  labelFormatter?: (label: string) => string;
}> = ({ active, payload, label, suffix = '', labelFormatter }) => {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      className="rounded-[9px] px-3 py-2 min-w-[132px]"
      style={{
        background: 'var(--surface-overlay)',
        backdropFilter: 'blur(16px) saturate(180%)',
        WebkitBackdropFilter: 'blur(16px) saturate(180%)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      {label && (
        <div
          className="text-[11.5px] font-semibold mb-1.5 pb-1.5"
          style={{
            color: 'var(--text-primary)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="rounded-[2px] shrink-0"
                style={{ width: 7, height: 7, background: entry.color }}
              />
              <span
                className="text-[11.5px] truncate"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {entry.name}
              </span>
            </div>
            <span
              className="text-[12px] font-semibold tabular shrink-0"
              style={{ color: 'var(--text-primary)' }}
            >
              {entry.value}
              {suffix}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Legend rendered as chips rather than Recharts' default inline text. */
export const ChartLegend: React.FC<{
  items: Array<{ label: string; color: string; value?: string | number }>;
  className?: string;
}> = ({ items, className }) => (
  <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${className ?? ''}`}>
    {items.map((item) => (
      <div key={item.label} className="flex items-center gap-1.5">
        <span
          className="rounded-[2px] shrink-0"
          style={{ width: 8, height: 8, background: item.color }}
        />
        <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          {item.label}
        </span>
        {item.value !== undefined && (
          <span
            className="text-[11.5px] font-semibold tabular"
            style={{ color: 'var(--text-secondary)' }}
          >
            {item.value}
          </span>
        )}
      </div>
    ))}
  </div>
);

/** Horizontal comparison bar used in the source/owner breakdown tables. */
export const MetricBar: React.FC<{
  value: number;
  max?: number;
  color?: string;
  height?: number;
}> = ({ value, max = 100, color = 'var(--accent)', height = 5 }) => (
  <div
    className="w-full rounded-full overflow-hidden"
    style={{ height, background: 'var(--surface-sunken)' }}
  >
    <div
      className="h-full rounded-full transition-all duration-500 ease-out"
      style={{
        width: `${Math.min(100, max > 0 ? (value / max) * 100 : 0)}%`,
        background: color,
      }}
    />
  </div>
);
