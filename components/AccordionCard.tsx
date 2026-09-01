'use client';

import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { Card } from './Card';

export interface AccordionCardProps {
  title: string;
  /** Live one-line summary in the header — readable while collapsed. */
  summary?: React.ReactNode;
  /** Longer description, shown only while open (collapsed rows stay compact). */
  subtitle?: string;
  icon?: LucideIcon;
  /** Right-hand badge/status. Non-interactive content only; clicks don't toggle. */
  action?: React.ReactNode;
  /**
   * Open state while the user has not toggled — derive it from live data
   * ("needs attention" sections default open, everything else collapsed).
   * A user toggle overrides it for the rest of the page's lifetime.
   */
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Collapsible Card for the Setup page. The body stays mounted while collapsed
 * (`hidden`) so half-typed credentials and fetch state survive a toggle.
 */
export const AccordionCard: React.FC<AccordionCardProps> = ({
  title,
  summary,
  subtitle,
  icon: Icon,
  action,
  defaultOpen = false,
  children,
  className,
}) => {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;
  const regionId = useId();
  const toggle = () => setOverride(!open);

  return (
    <Card padding="none" className={className}>
      <div
        className="flex items-center gap-3 px-5 py-3.5 cursor-pointer select-none"
        onClick={toggle}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left focus-ring rounded-[6px]"
        >
          {Icon && (
            <span
              className="h-6 w-6 grid place-items-center rounded-[6px] shrink-0"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
            >
              <Icon size={13.5} strokeWidth={2.2} />
            </span>
          )}
          <span className="min-w-0">
            <span
              className="block text-[13.5px] font-semibold leading-tight truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {title}
            </span>
            {summary && (
              <span
                className="block text-[12px] mt-0.5 leading-snug truncate"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {summary}
              </span>
            )}
          </span>
        </button>
        {action && (
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            {action}
          </div>
        )}
        <ChevronDown
          size={15}
          strokeWidth={2.2}
          className={clsx('shrink-0 transition-transform duration-200', open && 'rotate-180')}
          style={{ color: 'var(--text-quaternary)' }}
          aria-hidden
        />
      </div>

      <div id={regionId} hidden={!open} className="px-5 pb-5">
        {subtitle && (
          <p className="text-[12px] leading-snug -mt-1 mb-4" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </Card>
  );
};
