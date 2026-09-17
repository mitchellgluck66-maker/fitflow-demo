'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { formatPct, FUNNEL_MODE_LABELS, type Funnel, type ChipTone, type FunnelStageKey } from '@/lib/metrics';
import { RadialRing } from './RadialRing';

/**
 * Compact funnel summary for the Command Center — one slim row of stage
 * counts with the stage→stage conversion chips between them. It is a
 * summary, not the chart: the proportional bars, drop-off and people drawer
 * live on /funnel, which this whole strip links to.
 */
export type StripConversion = { from: FunnelStageKey; to: FunnelStageKey; current: number | null; previous: number | null; tone: ChipTone };

export const FunnelStrip: React.FC<{
  /** Either mode — the strip labels itself from `funnel.mode`. */
  funnel: Funnel;
  conversions: StripConversion[];
  href: string;
  rangeLabel: string;
  title?: string;
}> = ({ funnel, conversions, href, rangeLabel, title }) => {
  const stages = funnel.stages;
  const heading = title ?? (funnel.mode === 'cohort' ? `Funnel · ${FUNNEL_MODE_LABELS.cohort.label}` : 'Funnel');

  const chip = (tone: ChipTone): React.CSSProperties => {
    switch (tone) {
      case 'good':
        return { background: 'var(--positive-muted)', color: 'var(--positive-text)', border: '1px solid var(--positive-border)' };
      case 'warn':
        return { background: 'var(--negative-muted)', color: 'var(--negative-text)', border: '1px solid var(--negative-border)' };
      case 'ok':
        return { background: 'var(--surface-sunken)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' };
      default:
        return { background: 'var(--surface-sunken)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' };
    }
  };

  return (
    <Link
      href={href}
      className="group surface-raised focus-ring block rounded-[12px] px-4 py-3 transition-all duration-200 hover:-translate-y-px hover:shadow-[var(--shadow-md)]"
      style={{ minHeight: 90 }}
      title="Open the full funnel"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.045em]" style={{ color: 'var(--text-tertiary)' }}>
            {heading}
          </span>
          <span className="text-[11.5px] truncate" style={{ color: 'var(--text-quaternary)' }}>
            {rangeLabel}
          </span>
        </div>
        {funnel.previousLeads.count > 0 && (
          <span className="text-[11px] shrink-0" style={{ color: 'var(--text-quaternary)' }} title="Parked previous leads — not in the conversion chain">
            + {funnel.previousLeads.count} previous lead{funnel.previousLeads.count === 1 ? '' : 's'} parked
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[12px] font-medium shrink-0" style={{ color: 'var(--accent)' }}>
          Open funnel
          <ArrowRight size={13} strokeWidth={2.3} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
      </div>

      <div className="flex items-stretch gap-1 overflow-x-auto">
        {stages.map((s, i) => {
          const conv = i > 0 ? conversions[i - 1] : null;
          const isEnrolled = s.key === 'enrolled';
          return (
            <React.Fragment key={s.key}>
              {conv && (
                <div className="flex items-center shrink-0 px-0.5">
                  <span
                    className="inline-flex items-center gap-0.5 h-[20px] px-1.5 rounded-[5px] text-[11px] font-medium tabular"
                    style={chip(conv.tone)}
                    title={`${formatPct(conv.current)} of ${stages[i - 1].label.toLowerCase()} reached ${s.label.toLowerCase()}`}
                  >
                    <ChevronRight size={10} strokeWidth={2.4} style={{ opacity: 0.7 }} />
                    {formatPct(conv.current)}
                  </span>
                </div>
              )}
              <div
                className="flex-1 min-w-[96px] rounded-[8px] px-2.5 py-1.5"
                style={{
                  background: isEnrolled ? 'var(--positive-muted)' : 'var(--surface-sunken)',
                  border: `1px solid ${isEnrolled ? 'var(--positive-border)' : 'var(--border-subtle)'}`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] leading-tight truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {s.label}
                    </div>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span
                        className="text-[17px] font-semibold leading-none tabular tracking-[-0.01em]"
                        style={{ color: isEnrolled ? 'var(--positive-text)' : 'var(--text-primary)' }}
                      >
                        {s.count}
                      </span>
                      {!isEnrolled && (
                        <span className="text-[10.5px] tabular" style={{ color: 'var(--text-quaternary)' }}>
                          {formatPct(s.shareOfApplied)}
                        </span>
                      )}
                    </div>
                  </div>
                  {isEnrolled && (
                    // Applied → enrolled share: a rate with a natural 0–100% frame.
                    <RadialRing value={s.shareOfApplied} size={34} stroke={4} tone="positive" />
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </Link>
  );
};
