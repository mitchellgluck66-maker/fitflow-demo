'use client';

import React, { useEffect, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LineChart as LineIcon, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card, CardHeader } from './Card';
import { ChartTooltip, ChartLegend } from './Chart';
import { SkeletonChart } from './Skeleton';
import { EmptyState } from './PageHeader';
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
 * Full-width version of the KPI trend popover, opened from "Open in Metrics →"
 * (`/metrics?metric=<key>`). Same API, same series — just room to read it.
 */
export const MetricFocusCard: React.FC<{ metric: string }> = ({ metric }) => {
  const [trend, setTrend] = useState<MetricTrend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrend(null);
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

  if (error) {
    return (
      <Card padding="lg">
        <EmptyState compact title="Unknown metric" description={error} />
      </Card>
    );
  }
  if (!trend) {
    return (
      <Card padding="lg">
        <SkeletonChart height={220} />
      </Card>
    );
  }

  const scale = (v: number | null) => (v === null ? null : trend.kind === 'cents' ? v / 100 : trend.kind === 'pct' ? Math.round(v * 100) : v);
  const rows = trend.current.map((p, i) => ({ label: p.label, value: scale(p.value), prev: scale(trend.previous[i]?.value ?? null) }));
  const delta = computeDelta(trend.spanValue, trend.previousSpanValue, trend.lowerIsBetter);
  const DeltaIcon = delta.direction === 'up' ? TrendingUp : delta.direction === 'down' ? TrendingDown : Minus;
  const deltaColor = delta.good === null ? 'var(--text-tertiary)' : delta.good ? 'var(--positive-text)' : 'var(--negative-text)';

  return (
    <Card padding="lg">
      <CardHeader
        title={trend.label}
        subtitle={`${trend.grain === 'day' ? 'Last 30 days, daily' : 'Last 12 Sun–Sat weeks'} · ${trend.span.label} · faint = ${trend.previousSpan.label}`}
        icon={LineIcon}
        action={<ChartLegend items={[{ label: trend.label, color: 'var(--accent)' }]} />}
      />
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-[26px] font-semibold tabular tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
          {fmtValue(trend.spanValue, trend.kind)}
        </span>
        {delta.direction !== 'none' && (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold tabular" style={{ color: deltaColor }}>
            <DeltaIcon size={12} strokeWidth={2.4} /> {formatDelta(delta, trend.kind)} vs {trend.previousSpan.label}
          </span>
        )}
      </div>
      {trend.current.every((p) => p.value === null) ? (
        <EmptyState compact title="No data for this metric yet" description="Its inputs are missing for every bucket in the span — connect the source in Setup." />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={rows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="focusFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.2} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
            <YAxis tickLine={false} axisLine={false} allowDecimals={trend.kind !== 'count'} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
            <Tooltip content={<ChartTooltip suffix={trend.kind === 'pct' ? '%' : ''} />} />
            <Area type="monotone" dataKey="value" name={trend.label} stroke="var(--accent)" strokeWidth={2} fill="url(#focusFill)" connectNulls />
            <Line type="monotone" dataKey="prev" name="Prior span" stroke="var(--accent)" strokeOpacity={0.35} strokeDasharray="4 4" strokeWidth={1.4} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
};
