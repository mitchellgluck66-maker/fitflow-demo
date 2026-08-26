'use client';

import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, XCircle, X } from 'lucide-react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info' | 'warning';
  isVisible: boolean;
  onClose: () => void;
  duration?: number;
  detail?: string;
}

const TONES = {
  success: { icon: CheckCircle2, color: 'var(--success)' },
  error: { icon: XCircle, color: 'var(--danger)' },
  warning: { icon: AlertCircle, color: 'var(--warning)' },
  info: { icon: Info, color: 'var(--info)' },
} as const;

export const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  isVisible,
  onClose,
  duration = 4000,
  detail,
}) => {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!isVisible) return;
    setLeaving(false);

    // Start the exit animation slightly before unmounting so the toast slides
    // out rather than vanishing.
    const exitTimer = setTimeout(() => setLeaving(true), duration - 220);
    const closeTimer = setTimeout(onClose, duration);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(closeTimer);
    };
  }, [isVisible, duration, onClose]);

  if (!isVisible) return null;

  const tone = TONES[type];
  const Icon = tone.icon;

  return (
    <div
      className="fixed bottom-5 right-5 z-[100] max-w-sm"
      style={{
        animation: leaving
          ? 'fadeIn 200ms ease reverse both'
          : 'riseIn 260ms cubic-bezier(0.16,1,0.3,1) both',
      }}
    >
      <div
        className="flex items-start gap-2.5 rounded-[10px] px-3.5 py-3 pr-2.5"
        style={{
          background: 'var(--surface-overlay)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-lg), inset 0 1px 0 0 var(--border-highlight)',
        }}
      >
        <Icon
          size={15}
          strokeWidth={2.2}
          className="shrink-0 mt-px"
          style={{ color: tone.color }}
        />

        <div className="min-w-0 flex-1">
          <p
            className="text-[13px] font-medium leading-snug"
            style={{ color: 'var(--text-primary)' }}
          >
            {message}
          </p>
          {detail && (
            <p
              className="text-[12px] mt-0.5 leading-snug"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {detail}
            </p>
          )}
        </div>

        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 h-5 w-5 grid place-items-center rounded-[4px] transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--text-quaternary)' }}
        >
          <X size={12.5} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
};
