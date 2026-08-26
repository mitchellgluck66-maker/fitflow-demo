'use client';

import React from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'raised' | 'glass' | 'sunken' | 'flat';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hover?: boolean;
  onClick?: () => void;
}

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
} as const;

export const Card: React.FC<CardProps> = ({
  children,
  className,
  variant = 'raised',
  padding = 'md',
  hover = false,
  onClick,
}) => {
  const variantClass = {
    raised: 'surface-raised',
    glass: 'surface-glass',
    sunken: 'surface-sunken',
    flat: '',
  }[variant];

  return (
    <div
      onClick={onClick}
      className={clsx(
        'rounded-[12px] transition-all duration-200',
        variantClass,
        PADDING[padding],
        variant === 'flat' && 'bg-[var(--surface)] border border-[var(--border-subtle)]',
        hover &&
          'hover:-translate-y-px hover:shadow-[var(--shadow-md)] cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  );
};

/** Consistent card header: title, optional icon, optional right-hand action. */
export const CardHeader: React.FC<{
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}> = ({ title, subtitle, icon: Icon, action, className }) => (
  <div className={clsx('flex items-start justify-between gap-3 mb-4', className)}>
    <div className="flex items-start gap-2.5 min-w-0">
      {Icon && (
        <div
          className="mt-px h-6 w-6 grid place-items-center rounded-[6px] shrink-0"
          style={{
            background: 'var(--accent-muted)',
            color: 'var(--accent)',
          }}
        >
          <Icon size={13.5} strokeWidth={2.2} />
        </div>
      )}
      <div className="min-w-0">
        <h3
          className="text-[13.5px] font-semibold leading-tight truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {title}
        </h3>
        {subtitle && (
          <p
            className="text-[12px] mt-0.5 leading-snug"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);
