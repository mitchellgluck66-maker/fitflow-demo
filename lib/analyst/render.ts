/**
 * THE formatter (design review 2026-10-03, A): every number the owner reads is rendered here, from a
 * ledger entry — the engine's value, its unit, its currency — never by the model. One place decides
 * rounding, thousands separators, the currency code and whether a ratio reads as % or ×, so a displayed
 * number equals the engine's by construction.
 *
 * Values are rendered SIGN-FREE: a delta of −12 % reads "12%" and the sentence says "down" — the direction
 * check (`direction.ts`) holds the words to the sign.
 */

import type { LedgerEntry } from './ledger';

/** A reading hint from a ref token: `{ref|%}` share, `{ref|x}` multiple, `{ref|k}` compact money. */
export type RenderHint = '%' | 'x' | 'k' | null;

export function renderRef(entry: LedgerEntry, hint: RenderHint = null): string {
  if (entry.value === null) return '—';
  const abs = Math.abs(entry.value);
  switch (entry.unit) {
    case 'cents': {
      const dollars = abs / 100;
      if (hint === 'k' && dollars >= 10_000) return `$${(dollars / 1000).toFixed(1)}k ${entry.currency}`;
      const whole = Number.isInteger(dollars);
      return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} ${entry.currency}`;
    }
    case 'ratio': {
      const multiple = hint === 'x' || (hint !== '%' && entry.reading === 'multiple');
      if (multiple) return `${(Math.round(abs * 10) / 10).toFixed(1)}×`;
      const pct = Math.round(abs * 1000) / 10;
      return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
    }
    case 'count':
      return Math.round(abs).toLocaleString('en-US');
    case 'hours':
      return `${Math.round(abs * 10) / 10} h`;
    default:
      return String(Math.round(abs * 100) / 100);
  }
}
