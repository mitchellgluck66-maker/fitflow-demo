'use client';

import React, { useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { formatCents, formatPct, FUNNEL_STAGES, type Scorecard, type ChipTone } from '@/lib/metrics';
import { formatRangeLabel } from '@/lib/dates';
import { PeopleDrawer } from './PeopleDrawer';

/**
 * The funnel — horizontal proportional bars, never a tapered cone.
 *
 * Solid bar = who's there. Ghost segment = who dropped since the previous
 * stage, so solid + ghost together are exactly the previous bar's width.
 * The chip between rows is the stage→stage conversion, coloured against the
 * trailing 8-week average so a slipping step turns amber before it becomes
 * a problem. Click any bar to see the actual people.
 */
export const Funnel: React.FC<{
  scorecard: Scorecard;
  baseline: { start: string; end: string };
  rangeLabel: string;
  compact?: boolean;
  /** Bar height in px. The Funnel tab uses 44; compact = 22. */
  rowHeight?: number;
}> = ({ scorecard, baseline, rangeLabel, compact, rowHeight }) => {
  const stages = scorecard.funnel.stages;
  const max = Math.max(...stages.map((s) => s.count), 1);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const baselineLabel = formatRangeLabel(baseline.start, baseline.end);

  const toneStyle = (tone: ChipTone): React.CSSProperties => {
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

  const open = openIndex === null ? null : openIndex === -1 ? { label: 'Previous leads', count: scorecard.funnel.previousLeads.count, contactIds: scorecard.funnel.previousLeads.contactIds, shareOfApplied: null } : stages[openIndex];

  return (
    <div className="space-y-0.5">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1] : null;
        const solidPct = (s.count / max) * 100;
        const ghostPct = prev ? (Math.max(0, prev.count - s.count) / max) * 100 : 0;
        const short = FUNNEL_STAGES[i].shortLabel;
        const conv = i > 0 ? scorecard.conversions[i - 1] : null;
        const isEnrolled = s.key === 'enrolled';
        const barHeight = rowHeight ?? (compact ? 22 : 30);

        return (
          <React.Fragment key={s.key}>
            {conv && (
              <div className="flex items-center gap-2 pl-[160px] py-1">
                <ArrowDown size={11} strokeWidth={2.2} style={{ color: 'var(--text-quaternary)' }} />
                <span
                  className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[6px] text-[11.5px] font-medium tabular cursor-help"
                  style={toneStyle(conv.tone)}
                  title={`${formatPct(conv.current)} of ${prev!.label.toLowerCase()} reached ${s.label.toLowerCase()} · vs trailing 8-week avg (${baselineLabel})${
                    conv.previous !== null ? ` · comparison period ${formatPct(conv.previous)}` : ''
                  }`}
                >
                  {formatPct(conv.current)} → {short === 'client' ? 'enrolled' : s.label.toLowerCase()}
                  <span style={{ opacity: 0.75 }}>· {s.dropOff} dropped</span>
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setOpenIndex(i)}
              className="group focus-ring w-full flex items-center gap-3 rounded-[8px] px-1.5 py-1 text-left transition-colors hover:bg-[var(--surface-hover)]"
              title={`Show the ${s.count} ${s.count === 1 ? 'person' : 'people'} at ${s.label}`}
            >
              <div className="w-[148px] shrink-0">
                <div className="text-[13px] font-medium leading-tight" style={{ color: 'var(--text-primary)' }}>
                  {s.label}
                </div>
                <div className="text-[11.5px] tabular mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {s.count} · {formatPct(s.shareOfApplied)}
                  {s.costPerCents !== null && (
                    <>
                      {' '}
                      · {formatCents(s.costPerCents)}/{short}
                    </>
                  )}
                </div>
              </div>

              <div className="flex-1 flex items-center" style={{ height: barHeight }}>
                <div
                  className="h-full rounded-l-[5px] transition-[width] duration-500 group-hover:brightness-110"
                  style={{
                    width: `${solidPct}%`,
                    minWidth: s.count > 0 ? 6 : 0,
                    background: isEnrolled ? 'var(--positive)' : 'var(--accent)',
                    borderRadius: ghostPct > 0 ? '5px 0 0 5px' : 5,
                    boxShadow: isEnrolled ? '0 2px 12px var(--positive-muted)' : 'var(--shadow-accent)',
                  }}
                />
                {ghostPct > 0 && (
                  <div
                    className="h-full rounded-r-[5px] transition-[width] duration-500"
                    title={`${s.dropOff} dropped since ${prev!.label}`}
                    style={{
                      width: `${ghostPct}%`,
                      background:
                        'repeating-linear-gradient(135deg, var(--negative-muted) 0 6px, transparent 6px 12px)',
                      border: '1px dashed var(--negative-border)',
                      borderLeft: 'none',
                    }}
                  />
                )}
              </div>

              <div
                className="w-[52px] shrink-0 text-right text-[13px] font-semibold tabular"
                style={{ color: isEnrolled ? 'var(--positive-text)' : 'var(--text-primary)' }}
              >
                {s.count}
              </div>
            </button>
          </React.Fragment>
        );
      })}

      {scorecard.funnel.previousLeads.count > 0 && (
        <button
          type="button"
          onClick={() => setOpenIndex(-1)}
          className="group focus-ring w-full flex items-center gap-3 rounded-[8px] px-1.5 py-1 mt-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
          style={{ borderTop: '1px dashed var(--border-subtle)' }}
          title="Parked previous leads — counted here, never in the conversion chain above"
        >
          <div className="w-[148px] shrink-0">
            <div className="text-[13px] font-medium leading-tight" style={{ color: 'var(--text-tertiary)' }}>
              Previous leads
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-quaternary)' }}>
              parked · not in conversion
            </div>
          </div>
          <div className="flex-1 flex items-center" style={{ height: rowHeight ?? (compact ? 22 : 30) }}>
            <div
              className="h-full rounded-[5px]"
              style={{
                width: `${Math.min(100, (scorecard.funnel.previousLeads.count / max) * 100)}%`,
                minWidth: 6,
                background: 'repeating-linear-gradient(135deg, var(--surface-sunken) 0 6px, transparent 6px 12px)',
                border: '1px dashed var(--border-default)',
              }}
            />
          </div>
          <div className="w-[52px] shrink-0 text-right text-[13px] font-semibold tabular" style={{ color: 'var(--text-tertiary)' }}>
            {scorecard.funnel.previousLeads.count}
          </div>
        </button>
      )}

      <div className="flex items-center gap-4 pt-3 text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-[2px]" style={{ background: 'var(--accent)' }} /> at stage
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-[2px]" style={{ background: 'var(--positive)' }} /> enrolled
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="w-3 h-2 rounded-[2px]"
            style={{
              background: 'repeating-linear-gradient(135deg, var(--negative-muted) 0 3px, transparent 3px 6px)',
              border: '1px dashed var(--negative-border)',
            }}
          />{' '}
          dropped since previous stage
        </span>
        <span>chips vs trailing 8-week avg ({baselineLabel}) · click a bar for names</span>
      </div>

      <PeopleDrawer
        open={open !== null}
        onClose={() => setOpenIndex(null)}
        title={open ? `${open.label} · ${open.count}` : ''}
        subtitle={open ? (openIndex === -1 ? `${rangeLabel} · parked previous leads, outside conversion math` : `${rangeLabel} · ${formatPct(open.shareOfApplied)} of applied`) : undefined}
        contactIds={open?.contactIds ?? []}
      />
    </div>
  );
};
