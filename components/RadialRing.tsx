'use client';

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';

export interface RadialRingProps {
  /** 0..1, or null for "no data" (empty track, em dash). */
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  /** auto: ≥ 0.7 positive · < 0.5 negative · otherwise accent. */
  tone?: 'accent' | 'positive' | 'negative' | 'auto';
  animate?: boolean;
  className?: string;
}

const TONE_COLOR = {
  accent: 'var(--accent)',
  positive: 'var(--positive)',
  negative: 'var(--negative)',
} as const;

function resolveTone(value: number | null, tone: RadialRingProps['tone']): keyof typeof TONE_COLOR {
  if (tone && tone !== 'auto') return tone;
  if (value === null) return 'accent';
  if (value >= 0.7) return 'positive';
  if (value < 0.5) return 'negative';
  return 'accent';
}

/**
 * Corporate-sleek radial gauge for RATES with a natural 0–100% frame.
 * Never use it for counts or currency — those have no ceiling to sweep to.
 * Muted track, round-capped value arc, animated sweep on mount (skipped
 * under prefers-reduced-motion), value centred. Tokens only, both themes.
 */
export const RadialRing: React.FC<RadialRingProps> = ({
  value,
  size = 64,
  stroke = 6,
  label,
  sublabel,
  tone = 'auto',
  animate = true,
  className,
}) => {
  const clamped = value === null ? 0 : Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // Starts at 0 and sweeps to the value after paint. prefers-reduced-motion
  // is honoured by the global `transition-duration: 0.01ms` rule in
  // globals.css, so the ring simply appears at its value there.
  const [sweep, setSweep] = useState(0);

  useEffect(() => {
    // Two frames so the initial 0 paints before the transition kicks in.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSweep(clamped));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [clamped]);

  const color = TONE_COLOR[resolveTone(value, tone)];
  const fontSize = Math.max(10, Math.round(size * 0.21));
  const text = value === null ? '—' : `${Math.round(clamped * 100)}%`;

  return (
    <div className={clsx('inline-flex items-center gap-3', className)}>
      <div
        className="relative shrink-0"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${label ? `${label}: ` : ''}${text}`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-default)" strokeWidth={stroke} opacity={0.7} />
          {value !== null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - sweep)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: animate ? 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none' }}
            />
          )}
        </svg>
        <div
          className="absolute inset-0 grid place-items-center font-semibold tabular leading-none tracking-[-0.02em]"
          style={{ fontSize, color: value === null ? 'var(--text-quaternary)' : 'var(--text-primary)' }}
        >
          {text}
        </div>
      </div>
      {(label || sublabel) && (
        <div className="min-w-0">
          {label && (
            <div className="text-[12.5px] font-medium leading-tight" style={{ color: 'var(--text-primary)' }}>
              {label}
            </div>
          )}
          {sublabel && (
            <div className="text-[11.5px] mt-0.5 leading-snug" style={{ color: 'var(--text-quaternary)' }}>
              {sublabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
