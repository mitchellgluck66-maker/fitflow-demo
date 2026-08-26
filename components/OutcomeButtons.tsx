'use client';

import React from 'react';
import clsx from 'clsx';
import { Check, CalendarX, UserMinus, RotateCcw } from 'lucide-react';

export type Outcome = 'booked' | 'no_show' | 'not_continuing';

interface OutcomeConfig {
  value: Outcome;
  label: string;
  hint: string;
  color: string;
  icon: typeof Check;
}

/**
 * The three attendance outcomes.
 *
 * "Booked" means attended AND booked the next step - it advances the pipeline.
 * "Not Continuing" means they showed but are not moving forward, which closes
 * the opportunity as lost rather than leaving it open like a no-show does.
 */
export const OUTCOMES: OutcomeConfig[] = [
  {
    value: 'booked',
    label: 'Booked',
    hint: 'Attended and booked the next step',
    color: 'var(--success)',
    icon: Check,
  },
  {
    value: 'no_show',
    label: 'No Show',
    hint: 'Did not attend',
    color: 'var(--warning)',
    icon: CalendarX,
  },
  {
    value: 'not_continuing',
    label: 'Not Continuing',
    hint: 'Attended but is not moving forward',
    color: 'var(--danger)',
    icon: UserMinus,
  },
];

interface OutcomeButtonsProps {
  selected: Outcome | null;
  onSelect: (outcome: Outcome) => void;
  onClear?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export const OutcomeButtons: React.FC<OutcomeButtonsProps> = ({
  selected,
  onSelect,
  onClear,
  disabled = false,
  size = 'md',
}) => {
  const compact = size === 'sm';

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="flex items-center gap-0.5 p-0.5 rounded-[8px]"
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)',
        }}
      >
        {OUTCOMES.map((option) => {
          const active = selected === option.value;
          const Icon = option.icon;

          return (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              disabled={disabled}
              onClick={() => onSelect(option.value)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-[6px] font-medium',
                'transition-all duration-150 active:scale-[0.97] whitespace-nowrap',
                compact ? 'h-[26px] px-2 text-[11.5px]' : 'h-[30px] px-2.5 text-[12.5px]',
                disabled && 'opacity-45 pointer-events-none',
                !active && 'hover:bg-[var(--surface-hover)]',
              )}
              style={
                active
                  ? {
                      background: option.color,
                      color: '#fff',
                      boxShadow: `0 1px 6px color-mix(in srgb, ${option.color} 40%, transparent), inset 0 1px 0 0 rgba(255,255,255,0.2)`,
                    }
                  : { color: 'var(--text-tertiary)' }
              }
            >
              <Icon size={compact ? 12 : 13} strokeWidth={2.5} />
              {option.label}
            </button>
          );
        })}
      </div>

      {selected && onClear && (
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          title="Clear this outcome"
          aria-label="Clear outcome"
          className={clsx(
            'grid place-items-center rounded-[6px] transition-all duration-150',
            'hover:bg-[var(--surface-hover)] active:scale-95',
            compact ? 'h-[26px] w-[26px]' : 'h-[30px] w-[30px]',
          )}
          style={{ color: 'var(--text-quaternary)' }}
        >
          <RotateCcw size={compact ? 12 : 13} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
};
