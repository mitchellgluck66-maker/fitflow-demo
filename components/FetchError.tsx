'use client';

import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from './Button';

/**
 * The visible error state for a client-side fetch (2026-09-30, audit P1 #1): the sentence from
 * `lib/clientFetch` plus Retry. Never a blank, never a skeleton that stays.
 */
export const FetchError: React.FC<{ title: string; error: string; onRetry?: () => void; compact?: boolean }> = ({ title, error, onRetry, compact = false }) => (
  <div
    role="alert"
    data-testid="fetch-error"
    className={`flex flex-wrap items-start gap-3 rounded-[10px] ${compact ? 'px-3 py-2.5' : 'px-4 py-3.5'}`}
    style={{ background: 'var(--danger-muted)', border: '1px solid var(--danger-border)' }}
  >
    <AlertTriangle size={15} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
    <div className="flex-1 min-w-[200px]">
      <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </div>
      <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
        {error}
      </div>
    </div>
    {onRetry && (
      <Button size="sm" variant="secondary" icon={RotateCw} onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);
