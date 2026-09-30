'use client';

import React, { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, TrendingUp, TrendingDown, Minus, X } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from './Chart';
import { Skeleton } from './Skeleton';
import { MaturingBadge } from './MaturingBadge';
import { Popover } from './Popover';
import { computeDelta, formatCents, formatDelta, formatPct } from '@/lib/metrics';
import { TREND_WINDOWS, TREND_WINDOW_META, type MetricTrend, type TrendWindow } from '@/lib/metrics/trendMetrics';
import { useTrendWindow } from './useTrendWindow';

function fmtValue(v: number | null, kind: MetricTrend['kind'], currency: MetricTrend['currency']): string {
  if (v === null) return '—';
  if (kind === 'cents') return formatCents(v, currency);
  if (kind === 'pct') return formatPct(v);
  if (kind === 'ratio') return `${v.toFixed(2)}×`;
  return String(v);
}

const GRAIN_WORD = { day: 'daily', week: 'weekly', month: 'monthly' } as const;

/** "Last 3 months · Jun 14 – Sep 17, weekly" — the header names the window, its dates and its grain. */
export function trendWindowCaption(t: Pick<MetricTrend, 'windowLabel' | 'span' | 'grain'>): string {
  return `${t.windowLabel} · ${t.span.label}, ${GRAIN_WORD[t.grain]}`;
}

/** The trend URL: metric + window + the card's range (the highlight). */
export function trendUrl(metric: string, window: TrendWindow, card?: { start: string; end: string } | null): string {
  const q = new URLSearchParams({ metric, window });
  if (card) {
    q.set('start', card.start);
    q.set('end', card.end);
  }
  return `/api/metrics/trend?${q.toString()}`;
}

/** 30 days · 3 months · 6 months · 12 months — the same four for every metric. */
export const TrendWindowToggle: React.FC<{ value: TrendWindow; onChange: (w: TrendWindow) => void }> = ({ value, onChange }) => (
  <div className="inline-flex items-center rounded-[8px] p-0.5" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }} role="tablist" aria-label="Trend window">
    {TREND_WINDOWS.map((w) => {
      const active = w === value;
      return (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => onChange(w)}
          className="focus-ring h-6 px-2 rounded-[6px] text-[11.5px] font-medium tabular transition-colors"
          style={{ background: active ? 'var(--surface)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-tertiary)', boxShadow: active ? 'var(--shadow-sm)' : undefined }}
        >
          {TREND_WINDOW_META[w].short}
        </button>
      );
    })}
  </div>
);

/**
 * One shared drop-down for every KPI tile, one rule for every metric
 * (A1, 2026-09-30): last 3 months by default; 30 days (daily) · 3 / 6 months
 * (weekly, Sun–Sat) · 12 months (monthly), remembered per viewer. The header
 * names the window and shows the engine's value over it; the card's own range
 * is the highlighted band; the prior span is faint; the maturing badge stays.
 * Anchored under the tile; Esc or click-away closes.
 */
export const KpiTrendPopover: React.FC<{
  metric: string;
  /** The tile's own label, shown until the trend's label arrives. */
  label: string;
  /** The card's selected range — highlighted on the chart; its value equals the tile. */
  cardRange?: { start: string; end: string } | null;
  /** The tile element the panel anchors under. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}> = ({ metric, label, cardRange, anchorRef, onClose }) => {
  const [trend, setTrend] = useState<MetricTrend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useTrendWindow();
  const titleId = useId();
  const cardStart = cardRange?.start;
  const cardEnd = cardRange?.end;

  useEffect(() => {
    let cancelled = false;
    setTrend(null);
    setError(null);
    fetch(trendUrl(metric, win, cardStart && cardEnd ? { start: cardStart, end: cardEnd } : null))
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
        return body as MetricTrend;
      })
      .then((t) => {
        if (!cancelled) setTrend(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [metric, win, cardStart, cardEnd]);

  const rows =
    trend?.current.map((p, i) => ({
      key: p.start,
      /** The card's range: a full-height band on its own hidden axis (works for a single bucket too). */
      band: p.inCard ? 1 : null,
      label: p.label,
      value: p.value === null ? null : trend.kind === 'cents' ? p.value / 100 : trend.kind === 'pct' ? Math.round(p.value * 100) : p.value,
      prev: (() => {
        const q = trend.previous[i]?.value ?? null;
        return q === null ? null : trend.kind === 'cents' ? q / 100 : trend.kind === 'pct' ? Math.round(q * 100) : q;
      })(),
    })) ?? [];
  const delta = trend ? computeDelta(trend.spanValue, trend.previousSpanValue, trend.lowerIsBetter) : null;
  const DeltaIcon = delta?.direction === 'up' ? TrendingUp : delta?.direction === 'down' ? TrendingDown : Minus;
  const deltaColor = !delta || delta.good === null ? 'var(--text-tertiary)' : delta.good ? 'var(--positive-text)' : 'var(--negative-text)';
  const allNull = trend ? trend.current.every((p) => p.value === null) : false;
  const suffix = trend?.kind === 'pct' ? '%' : '';

  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} width={420} className="p-4" role="dialog" aria-labelledby={titleId}>
      <div onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div id={titleId} className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.045em]" style={{ color: 'var(--text-tertiary)' }}>
              {trend?.label ?? label}
              {trend?.maturing && <MaturingBadge maturity={trend.maturity} />}
            </div>
            {trend ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-[20px] font-semibold tabular tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
                  {fmtValue(trend.spanValue, trend.kind, trend.currency)}
                </span>
                {delta && delta.direction !== 'none' && (
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold tabular" style={{ color: deltaColor }} title={`vs ${trend.previousSpan.label}`}>
                    <DeltaIcon size={11} strokeWidth={2.4} />
                    {formatDelta(delta, trend.kind, trend.currency)}
                  </span>
                )}
              </div>
            ) : (
              <Skeleton className="h-5 w-24 mt-1" />
            )}
            {trend && (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-quaternary)' }}>
                {trendWindowCaption(trend)} · faint = {trend.previousSpan.label}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring h-6 w-6 grid place-items-center rounded-[5px] hover:bg-[var(--surface-hover)]" style={{ color: 'var(--text-quaternary)' }}>
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <TrendWindowToggle value={win} onChange={setWin} />
          {trend?.highlight && (
            <span className="inline-flex items-center gap-1.5 text-[11px] tabular" style={{ color: 'var(--text-tertiary)' }} title="The card's selected range — the highlighted band">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--accent)', opacity: 0.25 }} />
              Card {trend.highlight.label}: <strong style={{ color: 'var(--text-secondary)' }}>{fmtValue(trend.highlight.value, trend.kind, trend.currency)}</strong>
              {!trend.highlight.inWindow && ' (outside this window)'}
            </span>
          )}
        </div>

        {error ? (
          <p className="text-[12px]" style={{ color: 'var(--negative-text, var(--danger))' }}>
            {error}
          </p>
        ) : !trend ? (
          <Skeleton className="h-[120px]" />
        ) : allNull ? (
          <div className="rounded-[8px] px-3 py-2.5 text-[12px]" style={{ background: 'var(--surface-sunken)', border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)' }}>
            No data for this metric yet — its inputs are missing for every {trend.grain === 'day' ? 'day' : 'week'} in the span.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={130}>
            <ComposedChart data={rows} margin={{ top: 4, right: 4, left: -22, bottom: 0 }} barCategoryGap={0}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={trend.kind !== 'count'} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
              <YAxis yAxisId="band" hide domain={[0, 1]} />
              <Bar yAxisId="band" dataKey="band" name="Card range" fill="var(--accent)" fillOpacity={0.12} isAnimationActive={false} legendType="none" tooltipType="none" data-testid="card-band" />
              <Tooltip content={<ChartTooltip suffix={suffix} />} />
              <Line type="monotone" dataKey="prev" name="Prior span" stroke="var(--accent)" strokeOpacity={0.35} strokeDasharray="4 4" strokeWidth={1.4} dot={false} connectNulls />
              <Line type="monotone" dataKey="value" name={trend.label} stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
            Same engine as the tile · ratios from window totals.
          </span>
          <Link href={`/metrics?metric=${encodeURIComponent(metric)}`} className="text-[12px] font-medium inline-flex items-center gap-1 focus-ring rounded" style={{ color: 'var(--accent)' }}>
            Open in Metrics <ArrowRight size={12} />
          </Link>
        </div>
      </div>
    </Popover>
  );
};
