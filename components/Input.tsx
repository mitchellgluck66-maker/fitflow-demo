'use client';

import React from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  icon?: LucideIcon;
}

export const Input: React.FC<InputProps> = ({
  label,
  hint,
  error,
  icon: Icon,
  className,
  id,
  ...rest
}) => {
  const inputId = id ?? rest.name ?? label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-[12.5px] font-medium mb-1.5"
          style={{ color: 'var(--text-secondary)' }}
        >
          {label}
        </label>
      )}

      <div className="relative">
        {Icon && (
          <Icon
            size={14}
            strokeWidth={2}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-quaternary)' }}
          />
        )}
        <input
          id={inputId}
          className={clsx(
            'w-full h-8 px-2.5 text-[13px] rounded-[7px] transition-all duration-150',
            Icon && 'pl-8',
            className,
          )}
          style={{
            background: 'var(--surface)',
            color: 'var(--text-primary)',
            border: `1px solid ${error ? 'var(--danger)' : 'var(--border-default)'}`,
          }}
          {...rest}
        />
      </div>

      {(hint || error) && (
        <p
          className="text-[11.5px] mt-1.5 leading-snug"
          style={{ color: error ? 'var(--danger)' : 'var(--text-quaternary)' }}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
};

export const Select: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string }
> = ({ label, hint, className, id, children, ...rest }) => {
  const selectId = id ?? rest.name;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={selectId}
          className="block text-[12.5px] font-medium mb-1.5"
          style={{ color: 'var(--text-secondary)' }}
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={clsx(
          'w-full h-8 px-2.5 text-[13px] rounded-[7px] transition-all duration-150 cursor-pointer',
          className,
        )}
        style={{
          background: 'var(--surface)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-default)',
        }}
        {...rest}
      >
        {children}
      </select>
      {hint && (
        <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-quaternary)' }}>
          {hint}
        </p>
      )}
    </div>
  );
};

/** iOS-style switch used for boolean settings. */
export const Toggle: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, description, disabled }) => (
  <div className="flex items-start justify-between gap-4">
    {(label || description) && (
      <div className="min-w-0">
        {label && (
          <div
            className="text-[13px] font-medium"
            style={{ color: 'var(--text-primary)' }}
          >
            {label}
          </div>
        )}
        {description && (
          <div
            className="text-[12px] mt-0.5 leading-snug"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {description}
          </div>
        )}
      </div>
    )}

    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative shrink-0 rounded-full transition-all duration-200',
        disabled && 'opacity-45 pointer-events-none',
      )}
      style={{
        width: 34,
        height: 20,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        boxShadow: checked ? 'var(--shadow-accent)' : 'inset 0 1px 2px rgba(0,0,0,0.12)',
      }}
    >
      <span
        className="absolute rounded-full transition-all duration-200 ease-out"
        style={{
          width: 16,
          height: 16,
          top: 2,
          left: checked ? 16 : 2,
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        }}
      />
    </button>
  </div>
);
