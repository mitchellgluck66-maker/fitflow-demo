'use client';

import React from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'success';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  fullWidth?: boolean;
}

const SIZES = {
  xs: { pad: 'h-6 px-2 gap-1', text: 'text-[11.5px]', icon: 12, radius: 'rounded-[5px]' },
  sm: { pad: 'h-7 px-2.5 gap-1.5', text: 'text-[12.5px]', icon: 13, radius: 'rounded-[6px]' },
  md: { pad: 'h-8 px-3 gap-1.5', text: 'text-[13px]', icon: 14, radius: 'rounded-[7px]' },
  lg: { pad: 'h-9 px-4 gap-2', text: 'text-[13.5px]', icon: 15, radius: 'rounded-[8px]' },
} as const;

/**
 * Buttons carry their elevation through inline style rather than Tailwind
 * classes because the shadow recipe (ambient + contact + inset highlight)
 * references CSS custom properties that swap with the theme.
 */
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  fullWidth = false,
  disabled,
  className,
  ...rest
}) => {
  const s = SIZES[size];
  const isDisabled = disabled || loading;

  const styles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'var(--accent)',
      color: 'var(--accent-text)',
      border: '1px solid transparent',
      boxShadow: 'var(--shadow-accent), inset 0 1px 0 0 rgba(255,255,255,0.16)',
    },
    secondary: {
      background: 'var(--surface)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-default)',
      boxShadow: 'var(--shadow-xs), inset 0 1px 0 0 var(--border-highlight)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-default)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      border: '1px solid transparent',
    },
    danger: {
      background: 'var(--danger)',
      color: '#fff',
      border: '1px solid transparent',
      boxShadow: 'var(--shadow-sm), inset 0 1px 0 0 rgba(255,255,255,0.16)',
    },
    success: {
      background: 'var(--success)',
      color: '#fff',
      border: '1px solid transparent',
      boxShadow: 'var(--shadow-sm), inset 0 1px 0 0 rgba(255,255,255,0.16)',
    },
  };

  const hoverClass = {
    primary: 'hover:brightness-110',
    secondary: 'hover:bg-[var(--surface-hover)]',
    outline: 'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
    ghost: 'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
    danger: 'hover:brightness-110',
    success: 'hover:brightness-110',
  }[variant];

  return (
    <button
      disabled={isDisabled}
      className={clsx(
        'inline-flex items-center justify-center font-medium select-none',
        'transition-all duration-150 ease-out',
        'active:scale-[0.98] active:brightness-95',
        s.pad,
        s.text,
        s.radius,
        hoverClass,
        fullWidth && 'w-full',
        isDisabled && 'opacity-45 pointer-events-none',
        className,
      )}
      style={styles[variant]}
      {...rest}
    >
      {loading ? (
        <span
          className="rounded-full border-2 border-current border-r-transparent"
          style={{
            width: s.icon,
            height: s.icon,
            animation: 'spin 620ms linear infinite',
            opacity: 0.7,
          }}
        />
      ) : (
        Icon && <Icon size={s.icon} strokeWidth={2.1} className="shrink-0" />
      )}
      {children}
      {IconRight && !loading && (
        <IconRight size={s.icon} strokeWidth={2.1} className="shrink-0" />
      )}
    </button>
  );
};
