'use client';

import React from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared page header. Every route uses this so title size, spacing and the
 * accent glow are identical across the app - consistency here is most of what
 * separates a designed product from a collection of pages.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  children,
  className,
}) => (
  <div
    className={clsx('relative overflow-hidden accent-glow', className)}
    style={{
      background: 'var(--bg-canvas)',
      borderBottom: '1px solid var(--border-subtle)',
    }}
  >
    <div className="absolute inset-0 bg-grid opacity-70 pointer-events-none" />

    <div className="relative max-w-[1400px] mx-auto px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="text-[24px] font-semibold leading-tight tracking-[-0.03em]"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </h1>
          {description && (
            <p
              className="text-[13px] mt-1.5 leading-relaxed max-w-2xl"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {description}
            </p>
          )}
        </div>

        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>

      {children && <div className="mt-5">{children}</div>}
    </div>
  </div>
);

/** Standard page body wrapper - one max width and gutter for the whole app. */
export const PageBody: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <main className={clsx('max-w-[1400px] mx-auto px-5 py-6', className)}>
    {children}
  </main>
);

/** Section label used above groups of cards. */
export const SectionLabel: React.FC<{
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ children, action, className }) => (
  <div className={clsx('flex items-center justify-between gap-3 mb-3', className)}>
    <h2
      className="text-[11.5px] font-semibold uppercase tracking-[0.06em]"
      style={{ color: 'var(--text-quaternary)' }}
    >
      {children}
    </h2>
    {action}
  </div>
);

/** Consistent empty state across every list and table in the app. */
export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Tighter vertical padding for use inside a card. */
  compact?: boolean;
}> = ({ icon, title, description, action, compact = false }) => (
  <div className={clsx('flex flex-col items-center justify-center text-center px-6', compact ? 'py-8' : 'py-16')}>
    {icon && (
      <div
        className="h-11 w-11 grid place-items-center rounded-[11px] mb-3.5"
        style={{
          background: 'var(--surface-hover)',
          color: 'var(--text-quaternary)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {icon}
      </div>
    )}
    <p
      className="text-[13.5px] font-medium"
      style={{ color: 'var(--text-primary)' }}
    >
      {title}
    </p>
    {description && (
      <p
        className="text-[12.5px] mt-1 max-w-sm leading-relaxed"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {description}
      </p>
    )}
    {action && <div className="mt-4">{action}</div>}
  </div>
);
