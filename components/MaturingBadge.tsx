'use client';

import React from 'react';
import { Hourglass } from 'lucide-react';
import { MATURING_BADGE_LABEL, maturingCaveatText, type DataMaturity } from '@/lib/metrics/maturity';

/**
 * The maturing-data badge — the ONLY place the disclaimer is rendered in the
 * UI. Amber = the existing warning tone, kept quiet. Renders nothing unless
 * the caveat is active for the range in view. Callers decide *which*
 * metric gets it via isMaturingMetric / isMaturingStage; this component only
 * says it once.
 */
export const MaturingBadge: React.FC<{ maturity: DataMaturity | null | undefined; show?: boolean; compact?: boolean; className?: string }> = ({ maturity, show = true, compact, className }) => {
  if (!maturity?.active || !show) return null;
  const text = maturingCaveatText(maturity);
  return (
    <span
      className={`inline-flex items-center gap-1 h-[16px] px-1.5 rounded-[4px] text-[10px] font-semibold uppercase tracking-[0.04em] cursor-help align-middle ${className ?? ''}`}
      style={{ background: 'var(--warning-muted)', color: 'var(--warning)', border: '1px solid var(--warning-border)' }}
      title={text}
      aria-label={`${MATURING_BADGE_LABEL}: ${text}`}
      role="img"
    >
      <Hourglass size={9} strokeWidth={2.6} />
      {!compact && MATURING_BADGE_LABEL}
    </span>
  );
};
