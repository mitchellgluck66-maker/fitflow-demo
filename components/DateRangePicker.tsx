'use client';

import React, { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, ChevronDown } from 'lucide-react';
import {
  PRESETS,
  COMPARISONS,
  resolvePreset,
  resolveComparison,
  rangeFromParams,
  comparisonFromParam,
  todayInTimezone,
  isValidDate,
  type Preset,
  type ComparisonMode,
} from '@/lib/dates';
import { Select } from './Input';

/**
 * The one global date-range picker. State lives in the URL (?range, ?start,
 * ?end, ?compare) so a view is shareable and every fetch on the page reads
 * the same params. Every preset shows the dates it resolves to.
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-[7px] text-[13px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <CalendarDays size={14} strokeWidth={2.2} style={{ color: 'var(--accent)' }} />
          <span>{range.presetLabel}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>· {range.resolvedLabel}</span>
          <ChevronDown size={13} style={{ color: 'var(--text-quaternary)' }} />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
            <div
              className="absolute left-0 mt-1.5 z-[70] w-[300px] rounded-[10px] p-1.5 animate-scale"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
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
        )}
      </div>

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
