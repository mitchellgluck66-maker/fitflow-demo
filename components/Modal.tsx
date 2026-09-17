'use client';

import React, { useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
} as const;

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  actions,
  size = 'md',
}) => {
  // Escape to dismiss, and lock body scroll so the page behind doesn't drift.
  useEffect(() => {
    if (!isOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 'var(--z-overlay)' as unknown as number }}>
      <div
        onClick={onClose}
        className="absolute inset-0 animate-fade"
        style={{
          background: 'rgba(8, 9, 10, 0.5)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          'relative w-full rounded-[14px] animate-scale overflow-hidden',
          SIZES[size],
        )}
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-xl), inset 0 1px 0 0 var(--border-highlight)',
        }}
      >
        {(title || description) && (
          <div
            className="px-5 pt-5 pb-4 flex items-start justify-between gap-4"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            <div className="min-w-0">
              {title && (
                <h2
                  className="text-[15px] font-semibold leading-tight"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  className="text-[12.5px] mt-1 leading-snug"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {description}
                </p>
              )}
            </div>

            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 h-6 w-6 grid place-items-center rounded-[6px] transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <X size={14} strokeWidth={2.3} />
            </button>
          </div>
        )}

        <div className="px-5 py-5">{children}</div>

        {actions && (
          <div
            className="px-5 py-3.5 flex items-center justify-end gap-2"
            style={{
              borderTop: '1px solid var(--border-subtle)',
              background: 'var(--surface-sunken)',
            }}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
};
