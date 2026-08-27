'use client';

import React, { Suspense } from 'react';
import { Filter, Hourglass, Table2, CalendarCheck } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, SampleDataBanner, EmptyState, SkeletonChart, SkeletonTable, Skeleton, RadialRing } from '@/components';
import { SourceBreakdownTable } from '@/components/SourceBreakdownTable';
import { ChartTooltip } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Funnel } from '@/components/Funnel';
import { useScorecard } from '@/components/useScorecard';

import { ROLE_LABELS } from '@/lib/ghl/roles';

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 100) : null;
}

function FunnelTab() {
  const { data, loading, error } = useScorecard();

  const multiples = (() => {
    if (!data) return [];
    // Conversion ratios are only meaningful over whole weeks; daily counts
    // of 1-vs-0 produce 400% spikes that say nothing.
    const cur = data.trendWeekly.current;
    const cmp = data.trendWeekly.comparison;
    const series = (num: 'consultsBooked' | 'enrolled', den: 'applied' | 'consultsBooked') =>
      cur.map((p, i) => ({
        label: p.label,
        value: pct(p[num], p[den]),
        prev: cmp?.[i] ? pct(cmp[i][num], cmp[i][den]) : null,
      }));
    return [
      { title: 'Applied → Consult booked', rows: series('consultsBooked', 'applied') },
      { title: 'Consult booked → Enrolled', rows: series('enrolled', 'consultsBooked') },
      { title: 'Applied → Enrolled', rows: series('enrolled', 'applied') },
    ];
  })();

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Funnel" description="Every stage, every person behind it.">
          <DateRangePicker timezone="America/New_York" />
        </PageHeader>
        <PageBody className="space-y-5" aria-busy="true">
          <Card padding="lg">
            <Skeleton className="h-3 w-32 mb-4" />
            <SkeletonChart height={300} />
          </Card>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} padding="md">
                <Skeleton className="h-3 w-40 mb-3" />
                <SkeletonChart height={120} />
              </Card>
            ))}
          </div>
          <Card padding="lg">
            <Skeleton className="h-3 w-24 mb-4" />
            <SkeletonTable rows={5} cols={8} />
          </Card>
        </PageBody>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Funnel" />
        <PageBody>
          <EmptyState title="Could not load the funnel" description={error ?? 'Unknown error'} />
        </PageBody>
      </>
    );
  }

  const { scorecard, range, comparison } = data;
  const showRate = (type: string) => scorecard.showRates.find((r) => r.type === type) ?? null;
  const consult = showRate('Consult');
  const roadmap = showRate('Roadmap');
  const funnelEmpty = scorecard.funnel.stages.every((st) => st.count === 0);
  const days = (h: number | null) => (h === null ? '—' : h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(1)} days`);

  return (
    <>
      <PageHeader title="Funnel" description="Every stage, every person behind it.">
        <DateRangePicker timezone={data.timezone} />
      </PageHeader>

      <PageBody className="space-y-5">
        <SampleDataBanner page="funnel figures" />

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
          <Card padding="lg" className="lg:col-span-3">
            <CardHeader title="Full funnel" subtitle={`${range.presetLabel} · ${range.resolvedLabel}`} icon={Filter} />
            {funnelEmpty ? (
              <EmptyState
                compact
                title="No one entered the funnel in this range"
                description="Try Last 30 days, or run a sync from Setup to pull the latest opportunities."
              />
            ) : (
              <Funnel scorecard={scorecard} baseline={data.baseline} rangeLabel={range.resolvedLabel} rowHeight={44} />
            )}
          </Card>

          {/* ---- Show rates: rates with a natural 0–100% frame → rings ---- */}
          <Card padding="lg">
            <CardHeader title="Show rates" subtitle="showed ÷ (showed + no-show)" icon={CalendarCheck} />
            {!consult && !roadmap ? (
              <EmptyState compact title="No appointments in this range" description="Show rates appear once consults or roadmaps have an outcome." />
            ) : (
              <div className="flex flex-col gap-4">
                <RadialRing
                  value={consult?.rate ?? null}
                  size={72}
                  stroke={7}
                  label="Consult"
                  sublabel={consult ? `${consult.showed} showed · ${consult.noShow} no-show${consult.cancelled ? ` · ${consult.cancelled} cancelled` : ''}` : 'no consults'}
                />
                <RadialRing
                  value={roadmap?.rate ?? null}
                  size={72}
                  stroke={7}
                  label="Roadmap"
                  sublabel={roadmap ? `${roadmap.showed} showed · ${roadmap.noShow} no-show${roadmap.cancelled ? ` · ${roadmap.cancelled} cancelled` : ''}` : 'no roadmaps'}
                />
              </div>
            )}
          </Card>
        </div>

        {/* ---- Conversion over time ---- */}
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] mb-3" style={{ color: 'var(--text-quaternary)' }}>
            Conversion over time · Sun–Sat weeks
            {comparison.range ? ` · faded = ${comparison.range.resolvedLabel}` : ''}
          </div>
          {multiples.every((m) => m.rows.every((r) => r.value === null)) ? (
            <Card padding="lg">
              <EmptyState compact title="No conversions to plot yet" description="Small multiples fill in as weeks with applications accumulate." />
            </Card>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {multiples.map((m) => (
              <Card key={m.title} padding="md">
                <div className="text-[12.5px] font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  {m.title}
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={m.rows} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={30} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
                    <YAxis tickLine={false} axisLine={false} domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text-quaternary)' }} />
                    <Tooltip content={<ChartTooltip suffix="%" />} />
                    <Line type="monotone" dataKey="prev" name="Comparison" stroke="var(--accent)" strokeOpacity={0.4} strokeDasharray="4 4" strokeWidth={1.4} dot={false} connectNulls />
                    <Line type="monotone" dataKey="value" name="This period" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            ))}
          </div>
          )}
        </div>

        {/* ---- Per-source table ---- */}
        <Card padding="lg">
          <CardHeader title="By source" subtitle="Volume says where leads come from; the last two columns say which ones are worth having." icon={Table2} />
          {scorecard.sources.length === 0 ? (
            <EmptyState compact title="No contacts in this period" description="Sources appear as soon as someone applies in the selected range." />
          ) : (
            <SourceBreakdownTable sources={scorecard.sources} />
          )}
        </Card>

        {/* ---- Time in stage ---- */}
        <Card padding="lg">
          <CardHeader title="Time in stage" subtitle="How long people sat in a stage before moving on (moves inside the period)" icon={Hourglass} />
          {scorecard.timeInStage.length === 0 ? (
            <EmptyState compact title="No stage moves in this range" description="Try Last 30 days, or run a sync — time in stage needs at least one observed move." />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {scorecard.timeInStage.map((t) => (
                <div key={t.role} className="px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
                  <div className="text-[11px] font-medium uppercase tracking-wide truncate" style={{ color: 'var(--text-quaternary)' }}>
                    {ROLE_LABELS[t.role] ?? t.role}
                  </div>
                  <div className="text-[18px] font-semibold tabular mt-1" style={{ color: 'var(--text-primary)' }}>
                    {days(t.medianHours)}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                    median · {t.samples} moves · mean {days(t.meanHours)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </PageBody>
    </>
  );
}

export default function FunnelPage() {
  return (
    <Suspense
      fallback={
        <PageBody className="space-y-5" aria-busy="true">
          <SkeletonChart height={300} />
          <SkeletonTable rows={5} cols={8} />
        </PageBody>
      }
    >
      <FunnelTab />
    </Suspense>
  );
}
