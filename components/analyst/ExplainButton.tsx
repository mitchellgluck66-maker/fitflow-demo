'use client';

import React from 'react';
import { useAnalystOptional } from './AnalystProvider';

/**
 * "What does this mean?" (Wave 2 item 6; the demo's hover affordance). Opens the Analyst with the metric and the range
 * on screen as context; the answer is the glossary's definition + worked formula and the three sections. Hidden until
 * the host is hovered (`.explain-host:hover`), always visible on touch, icon-only in table and chart headers. Renders
 * nothing outside the provider (the login page, tests). `data-explain` is what the coverage audit reads.
 */
export function ExplainButton({ metricKey, label, variant = 'full', className, stopPropagation = true, visible = false }: { metricKey: string; label: string; variant?: 'full' | 'icon'; className?: string; stopPropagation?: boolean; /** Always shown (a section header), not only on hover. */ visible?: boolean }) {
  const a = useAnalystOptional();
  if (!a) return null;
  const onClick = (e: React.MouseEvent) => {
    if (stopPropagation) {
      e.stopPropagation();
      e.preventDefault();
    }
    a.explain(metricKey, label);
  };
  return (
    <button
      type="button"
      className={`explain-btn${variant === 'icon' ? ' is-icon' : ''}${className ? ` ${className}` : ''}`}
      data-explain={metricKey}
      data-visible={visible ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={(e) => e.stopPropagation()}
      title={`What does ${label} mean?`}
      aria-label={`What does ${label} mean?`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      {variant === 'full' ? <span>What does this mean?</span> : null}
    </button>
  );
}

/** "Ask the Analyst about this" (Wave 2 item 5): opens the panel with the clicked thing as context and asks the given question. */
export function AskAboutButton({ selected, question, label, variant = 'icon', className }: { selected: { kind: 'campaign' | 'client' | 'stage' | 'metric'; id: string; label?: string }; question: string; label?: string; variant?: 'icon' | 'button'; className?: string }) {
  const a = useAnalystOptional();
  if (!a) return null;
  const text = label ?? `Ask the Analyst about ${selected.label ?? 'this'}`;
  return (
    <button
      type="button"
      className={`${variant === 'icon' ? 'explain-btn is-icon' : 'explain-ask'}${className ? ` ${className}` : ''}`}
      data-ask-about={selected.kind}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        a.askAbout(selected, question);
      }}
      title={text}
      aria-label={text}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M12 3a9 9 0 0 0-7.6 13.8L3 21l4.4-1.3A9 9 0 1 0 12 3z" />
        <path d="M9.5 10.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.4V15M12 17.5h.01" />
      </svg>
      {variant === 'button' ? <span>{text}</span> : null}
    </button>
  );
}
