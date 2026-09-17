'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, TrendingUp, TrendingDown, Minus, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from './Chart';
import { Skeleton } from './Skeleton';
import { computeDelta, formatCents, formatDelta, formatPct } from '@/lib/metrics';
import type { MetricTrend } from '@/lib/metrics/trendMetrics';

function fmtValue(v: number | null, kind: MetricTrend['kind']): string {
  if (v === null) return '—';
  if (kind === 'cents') return formatCents(v);
  if (kind === 'pct') return formatPct(v);
  if (kind === 'ratio') return `${v.toFixed(2)}×`;
  return String(v);
}

/**
 * One shared popover for every KPI tile: a small trend of THAT metric —
 * daily over the last 30 days for volume/cash, weekly over the last 12
 * Sun–Sat weeks for rates and CAC — with a faint line for the prior
 * equivalent span, the span value + delta in the header, and an "Open in
 * Metrics →" link. Anchored under the tile; Esc or click-away closes.
 */
export const KpiTrendPopover: React.FC<{
  metric: string;
  /** The tile's own label, shown until the trend's label arrives. */
  label: string;
  onClose: () => void;
}> = ({ metric, label, onClose }) => {
  const [trend, setTrend] = useState<MetricTrend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/metrics/trend?metric=${encodeURIComponent(metric)}`)
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
  }, [metric]);

  // Esc and click-away. A document listener rather than an overlay element:
  // the tile animates with a transform, which would trap a fixed overlay
  // inside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = e.target as Node;
      if (panel.contains(target) || panel.parentElement?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const rows =
    trend?.current.map((p, i) => ({
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
    <>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 top-[calc(100%+6px)] z-[70] w-[min(420px,calc(100vw-32px))] rounded-[12px] p-4 animate-scale focus:outline-none"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div id={titleId} className="text-[11.5px] font-medium uppercase tracking-[0.045em]" style={{ color: 'var(--text-tertiary)' }}>
              {trend?.label ?? label}
            </div>
            {trend ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-[20px] font-semibold tabular tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
                  {fmtValue(trend.spanValue, trend.kind)}
                </span>
                {delta && delta.direction !== 'none' && (
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold tabular" style={{ color: deltaColor }} title={`vs ${trend.previousSpan.label}`}>
                    <DeltaIcon size={11} strokeWidth={2.4} />
                    {formatDelta(delta, trend.kind === 'pct' ? 'pct' : trend.kind)}
                  </span>
                )}
              </div>
            ) : (
              <Skeleton className="h-5 w-24 mt-1" />
            )}
            {trend && (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-quaternary)' }}>
                {trend.grain === 'day' ? 'Last 30 days, daily' : 'Last 12 Sun–Sat weeks'} · {trend.span.label} · faint = {trend.previousSpan.label}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring h-6 w-6 grid place-items-center rounded-[5px] hover:bg-[var(--surface-hover)]" style={{ color: 'var(--text-quaternary)' }}>
            <X size={13} />
          </button>
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
            <LineChart data={rows} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={trend.kind !== 'count'} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
              <Tooltip content={<ChartTooltip suffix={suffix} />} />
              <Line type="monotone" dataKey="prev" name="Prior span" stroke="var(--accent)" strokeOpacity={0.35} strokeDasharray="4 4" strokeWidth={1.4} dot={false} connectNulls />
              <Line type="monotone" dataKey="value" name={trend.label} stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
            {trend?.grain === 'week' ? 'Weekly grain: ratios and CAC are noise day by day.' : 'Same engine as the tile.'}
          </span>
          <Link href={`/metrics?metric=${encodeURIComponent(metric)}`} className="text-[12px] font-medium inline-flex items-center gap-1 focus-ring rounded" style={{ color: 'var(--accent)' }}>
            Open in Metrics <ArrowRight size={12} />
          </Link>
        </div>
      </div>
    </>
  );
};
