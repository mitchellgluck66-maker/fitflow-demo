'use client';

import React from 'react';
import { GitBranch, CalendarCheck, CreditCard, History } from 'lucide-react';
import { Badge } from './Badge';
import type { TimelineItem } from '@/lib/queries/clients';

const ICON = { transition: GitBranch, appointment: CalendarCheck, payment: CreditCard } as const;

const TONE_COLOR: Record<TimelineItem['tone'], string> = {
  positive: 'var(--positive-text, var(--success))',
  negative: 'var(--negative-text, var(--danger))',
  neutral: 'var(--text-tertiary)',
};

const TONE_BG: Record<TimelineItem['tone'], string> = {
  positive: 'var(--positive-muted, var(--success-muted))',
  negative: 'var(--negative-muted, var(--danger-muted))',
  neutral: 'var(--surface-sunken)',
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/** Unified, newest-first history of everything observed about one person. */
export const ClientTimeline: React.FC<{ items: TimelineItem[] }> = ({ items }) => {
  if (items.length === 0) {
    return (
      <p className="text-[12.5px] py-6 text-center" style={{ color: 'var(--text-tertiary)' }}>
        Nothing observed yet for this person.
      </p>
    );
  }

  return (
    <ol className="relative pl-7">
      <div className="absolute left-[11px] top-2 bottom-2 w-px" style={{ background: 'var(--border-subtle)' }} />
      {items.map((item) => {
        const Icon = ICON[item.type];
        return (
          <li key={item.id} className="relative pb-4 last:pb-0">
            <span
              className="absolute -left-7 top-0.5 h-[22px] w-[22px] grid place-items-center rounded-full"
              style={{ background: TONE_BG[item.tone], color: TONE_COLOR[item.tone], border: '1px solid var(--border-subtle)' }}
            >
              <Icon size={11} strokeWidth={2.4} />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[13px] font-medium" style={{ color: item.tone === 'neutral' ? 'var(--text-primary)' : TONE_COLOR[item.tone] }}>
                {item.title}
              </span>
              <span className="text-[11.5px] tabular" style={{ color: 'var(--text-quaternary)' }}>
                {fmt(item.at)}
              </span>
              {item.backfilled && (
                <Badge variant="neutral" size="xs">
                  <History size={10} className="mr-1" />
                  backfilled
                </Badge>
              )}
            </div>
            {item.detail && (
              <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {item.detail}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
};
