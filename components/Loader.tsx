'use client';

import React from 'react';
import clsx from 'clsx';

export interface LoaderProps {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'spinner' | 'dots' | 'bar';
  label?: string;
  className?: string;
}

const SIZES = { sm: 14, md: 20, lg: 28 } as const;

export const Loader: React.FC<LoaderProps> = ({
  size = 'md',
  variant = 'spinner',
  label,
  className,
}) => {
  const px = SIZES[size];

  if (variant === 'dots') {
    return (
      <div className={clsx('flex items-center gap-1.5', className)}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="rounded-full"
            style={{
              width: px / 3.2,
              height: px / 3.2,
              background: 'var(--accent)',
              animation: `pulseSoft 1.1s ${i * 0.16}s ease-in-out infinite`,
            }}
          />
        ))}
        {label && (
          <span className="ml-1 text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
            {label}
          </span>
        )}
      </div>
    );
  }

  if (variant === 'bar') {
    return (
      <div
        className={clsx('w-full rounded-full overflow-hidden skeleton', className)}
        style={{ height: 3 }}
      />
    );
  }

  return (
    <div className={clsx('flex flex-col items-center gap-2.5', className)}>
      <span
        className="rounded-full border-2 block"
        style={{
          width: px,
          height: px,
          borderColor: 'var(--border-default)',
          borderTopColor: 'var(--accent)',
          animation: 'spin 640ms linear infinite',
        }}
      />
      {label && (
        <span className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
          {label}
        </span>
      )}
    </div>
  );
};

/** Full-page loading state used while a route's first payload lands. */
export const PageLoader: React.FC<{ label?: string }> = ({ label = 'Loading' }) => (
  <div className="flex items-center justify-center py-28">
    <Loader size="lg" label={label} />
  </div>
);

/** Skeleton row for tables and lists. */
export const SkeletonRow: React.FC<{ className?: string }> = ({ className }) => (
  <div className={clsx('skeleton rounded-[8px] h-12 w-full', className)} />
);
