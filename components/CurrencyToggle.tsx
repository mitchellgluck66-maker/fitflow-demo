'use client';

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CURRENCIES, CURRENCY_CHANGED_EVENT, type Currency } from '@/lib/money';

/**
 * CAD | USD reporting-currency switch, next to the theme toggle.
 *
 * Unlike the theme this is NOT a per-browser preference: it writes the ONE
 * business-wide `reporting_currency` setting, so Jake's choice also drives
 * the digests and the AI context. Flipping it fires CURRENCY_CHANGED_EVENT;
 * every data hook re-fetches and the server re-converts from the stored
 * originals (never from already-converted figures).
 */
export const CurrencyToggle: React.FC<{ className?: string }> = ({ className }) => {
  const [current, setCurrent] = useState<Currency | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch('/api/currency')
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { reporting?: Currency } | null) => d?.reporting && setCurrent(d.reporting))
        .catch(() => undefined);
    load();
    // Setup → Currency changes it too.
    window.addEventListener(CURRENCY_CHANGED_EVENT, load);
    return () => window.removeEventListener(CURRENCY_CHANGED_EVENT, load);
  }, []);

  const pick = async (next: Currency) => {
    if (busy || next === current) return;
    setBusy(true);
    const previous = current;
    setCurrent(next);
    try {
      const r = await fetch('/api/currency', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportingCurrency: next }) });
      if (!r.ok) throw new Error('save failed');
      window.dispatchEvent(new Event(CURRENCY_CHANGED_EVENT));
    } catch {
      setCurrent(previous);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Reporting currency (applies to everyone, emails and AI)"
      title="Reporting currency — one business-wide setting: dashboards, emails and AI answers all use it"
      className={clsx('flex items-center h-8 p-[3px] rounded-[7px] border', busy && 'opacity-70', className)}
      style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-xs), inset 0 1px 0 0 var(--border-highlight)' }}
    >
      {CURRENCIES.map((c) => {
        const active = c === current;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={busy || current === null}
            onClick={() => pick(c)}
            className="focus-ring h-full px-2 rounded-[5px] text-[11px] font-semibold tracking-[0.02em] transition-colors duration-150"
            style={{
              color: active ? 'var(--text-primary)' : 'var(--text-quaternary)',
              background: active ? 'var(--surface-hover)' : 'transparent',
            }}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
};
