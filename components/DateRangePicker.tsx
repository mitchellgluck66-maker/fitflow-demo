'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  PRESETS,
  COMPARISONS,
  resolvePreset,
  resolveComparison,
  rangeFromParams,
  comparisonFromParam,
  todayInTimezone,
  isValidDate,
  periodFamily,
  stepPeriod,
  canStepForward,
  paramsForRange,
  periodTitle,
  type Preset,
  type ComparisonMode,
} from '@/lib/dates';
import { Select } from './Input';
import { Popover } from './Popover';

/**
 * The one global date-range picker. State lives in the URL (?range, ?start,
 * ?end, ?compare) so a view is shareable and every fetch on the page reads
 * the same params. Every preset shows the dates it resolves to.
 *
 * Period cycler: on a week or month preset, ◀ ▶ step one whole Sun–Sat week
 * / calendar month (anchored as ?range=week|month&start=…). The comparison
 * setting is untouched, so delta chips always read against the period before
 * the one displayed; ▶ disables at the current period. ← → do the same while
 * the picker has focus.
 */
export const DateRangePicker: React.FC<{ timezone?: string }> = ({ timezone = 'America/New_York' }) => {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = todayInTimezone(timezone);

  const range = useMemo(
    () => rangeFromParams({ range: params.get('range'), start: params.get('start'), end: params.get('end') }, today),
    [params, today],
  );
  const compareMode = comparisonFromParam(params.get('compare'));
  const comparison = resolveComparison(range, compareMode, today);

  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [customStart, setCustomStart] = useState(range.start);
  const [customEnd, setCustomEnd] = useState(range.end);

  const push = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    router.replace(`${pathname}?${q.toString()}`);
  };

  const family = periodFamily(range);
  const forwardOk = canStepForward(range, today);
  // Step from the LIVE URL, not the rendered closure: router.replace resolves
  // asynchronously, so two quick clicks (or a held arrow key) must each
  // advance one period instead of recomputing the same one.
  const step = useCallback(
    (direction: -1 | 1) => {
      const live = new URLSearchParams(window.location.search);
      const current = rangeFromParams({ range: live.get('range'), start: live.get('start'), end: live.get('end') }, today);
      const next = stepPeriod(current, direction, today);
      if (next === current) return;
      const q = new URLSearchParams(live.toString());
      for (const [k, v] of Object.entries(paramsForRange(next))) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      // Keep the history entry count sane while cycling: replace, not push.
      window.history.replaceState(window.history.state, '', `${pathname}?${q.toString()}`);
      router.replace(`${pathname}?${q.toString()}`);
    },
    [today, pathname, router],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!family) return;
    const t = e.target as HTMLElement;
    // Native selects and date inputs own their arrow keys.
    if (t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  };

  const choosePreset = (preset: Preset) => {
    if (preset === 'custom') {
      push({ range: 'custom', start: customStart, end: customEnd });
    } else {
      push({ range: preset, start: null, end: null });
      setOpen(false);
    }
  };

  const applyCustom = () => {
    if (!isValidDate(customStart) || !isValidDate(customEnd)) return;
    push({ range: 'custom', start: customStart, end: customEnd });
    setOpen(false);
  };

  const arrow = (direction: -1 | 1) => {
    const disabled = direction === 1 && !forwardOk;
    const Icon = direction === -1 ? ChevronLeft : ChevronRight;
    const what = family === 'week' ? 'week' : 'month';
    return (
      <button
        type="button"
        onClick={() => step(direction)}
        disabled={disabled}
        aria-label={direction === -1 ? `Previous ${what}` : `Next ${what}`}
        title={disabled ? `Already on the current ${what}` : `${direction === -1 ? 'Previous' : 'Next'} ${what} (${direction === -1 ? '←' : '→'})`}
        className="focus-ring h-8 w-8 grid place-items-center rounded-[7px] transition-colors enabled:hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
      >
        <Icon size={15} strokeWidth={2.3} />
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2" onKeyDown={onKeyDown} role="group" aria-label="Date range">
      {family && arrow(-1)}
      <div className="relative">
        <button
          ref={anchorRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-[7px] text-[13px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <CalendarDays size={14} strokeWidth={2.2} style={{ color: 'var(--accent)' }} />
          {family ? (
            <>
              <span>{periodTitle(range)}</span>
              {(range.preset === 'this_week' || range.preset === 'last_week' || range.preset === 'this_month' || range.preset === 'last_month') && (
                <span style={{ color: 'var(--text-tertiary)' }}>· {range.presetLabel}</span>
              )}
            </>
          ) : (
            <>
              <span>{range.presetLabel}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>· {range.resolvedLabel}</span>
            </>
          )}
          <ChevronDown size={13} style={{ color: 'var(--text-quaternary)' }} />
        </button>

        <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} width={300} className="p-1.5" role="dialog" aria-labelledby="date-range-presets">
          <span id="date-range-presets" className="sr-only">
            Date range presets
          </span>
          <>
            <div>
              {PRESETS.filter((p) => p.value !== 'custom').map((p) => {
                const r = resolvePreset(p.value, today);
                const active = range.preset === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => choosePreset(p.value)}
                    className="w-full flex items-center justify-between gap-3 h-8 px-2.5 rounded-[6px] text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                    style={{
                      background: active ? 'var(--accent-muted)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-primary)',
                    }}
                  >
                    <span className="font-medium">{p.label}</span>
                    <span className="tabular" style={{ color: active ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                      {r.resolvedLabel}
                    </span>
                  </button>
                );
              })}

              <div className="mt-1.5 pt-2 px-2.5 pb-1.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-quaternary)' }}>
                  Custom range
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={customStart}
                    max={customEnd}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="h-7 px-1.5 text-[12px] rounded-[6px] flex-1 min-w-0"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                  <span style={{ color: 'var(--text-quaternary)' }}>–</span>
                  <input
                    type="date"
                    value={customEnd}
                    min={customStart}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="h-7 px-1.5 text-[12px] rounded-[6px] flex-1 min-w-0"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                  <button
                    type="button"
                    onClick={applyCustom}
                    className="h-7 px-2.5 rounded-[6px] text-[12px] font-medium"
                    style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          </>
        </Popover>
      </div>

      {family && arrow(1)}

      <div className="w-[270px]">
        <Select
          value={compareMode}
          onChange={(e) => push({ compare: e.target.value as ComparisonMode })}
          aria-label="Comparison period"
        >
          {COMPARISONS.map((c) => {
            const label =
              c.value === 'off' ? c.label : `${c.label} · ${resolveComparison(range, c.value, today).range?.resolvedLabel}`;
            return (
              <option key={c.value} value={c.value}>
                {label}
              </option>
            );
          })}
        </Select>
      </div>

      {comparison.range && (
        <span className="text-[11.5px] hidden lg:inline" style={{ color: 'var(--text-quaternary)' }} title={comparison.label}>
          Comparing {range.resolvedLabel} with {comparison.range.resolvedLabel}
        </span>
      )}
    </div>
  );
};
