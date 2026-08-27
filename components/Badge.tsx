'use client';

import React from 'react';
import clsx from 'clsx';

export interface BadgeProps {
  children: React.ReactNode;
  variant?:
    | 'accent'
    | 'success'
    | 'warning'
    | 'danger'
    | 'info'
    | 'neutral'
    | 'outline'
    | 'positive'
    | 'negative';
  size?: 'xs' | 'sm' | 'md';
  dot?: boolean;
  className?: string;
}

const TONES: Record<string, { bg: string; fg: string; border: string }> = {
  accent: {
    bg: 'var(--accent-muted)',
    fg: 'var(--accent)',
    border: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },
  success: {
    bg: 'var(--success-muted)',
    fg: 'var(--success)',
    border: 'var(--success-border)',
  },
  warning: {
    bg: 'var(--warning-muted)',
    fg: 'var(--warning)',
    border: 'var(--warning-border)',
  },
  danger: {
    bg: 'var(--danger-muted)',
    fg: 'var(--danger)',
    border: 'var(--danger-border)',
  },
  info: {
    bg: 'var(--info-muted)',
    fg: 'var(--info)',
    border: 'var(--info-border)',
  },
  neutral: {
    bg: 'var(--surface-hover)',
    fg: 'var(--text-secondary)',
    border: 'var(--border-subtle)',
  },
  outline: {
    bg: 'transparent',
    fg: 'var(--text-secondary)',
    border: 'var(--border-default)',
  },
  // Outcome semantics: enrolled/converted vs drop-off/lost/failed.
  positive: {
    bg: 'var(--positive-muted)',
    fg: 'var(--positive-text)',
    border: 'var(--positive-border)',
  },
  negative: {
    bg: 'var(--negative-muted)',
    fg: 'var(--negative-text)',
    border: 'var(--negative-border)',
  },
};

const SIZES = {
  xs: 'h-[18px] px-1.5 text-[10.5px] gap-1 rounded-[4px]',
  sm: 'h-[21px] px-2 text-[11.5px] gap-1.5 rounded-[5px]',
  md: 'h-[25px] px-2.5 text-[12.5px] gap-1.5 rounded-[6px]',
} as const;

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  size = 'sm',
  dot = false,
  className,
}) => {
  const tone = TONES[variant] ?? TONES.neutral;

  return (
    <span
      className={clsx(
        'inline-flex items-center font-medium whitespace-nowrap border leading-none',
        SIZES[size],
        className,
      )}
      style={{
        background: tone.bg,
        color: tone.fg,
        borderColor: tone.border,
      }}
    >
      {dot && (
        <span
          className="rounded-full shrink-0"
          style={{ width: 5, height: 5, background: 'currentColor' }}
        />
      )}
      {children}
    </span>
  );
};
