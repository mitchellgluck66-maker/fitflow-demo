'use client';

import React, { Suspense } from 'react';
import { Filter, Hourglass, Table2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Badge } from '@/components';
import { ChartTooltip } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Funnel } from '@/components/Funnel';
import { useScorecard } from '@/components/useScorecard';
import { formatPct, FUNNEL_STAGES, type FunnelStageKey } from '@/lib/metrics';
import { ROLE_LABELS } from '@/lib/ghl/roles';

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 100) : null;
}

function FunnelTab() {
  const { data, loading, error } = useScorecard();

  const multiples = (() => {
    if (!data) return [];
    const cur = data.trend.current;
    const cmp = data.trend.comparison;
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
        <PageHeader title="Funnel" description="Where people drop, by stage and by source." />
        <PageBody>
          <PageLoader label="Computing funnel" />
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
  const stageKeys = FUNNEL_STAGES.map((s) => s.key) as FunnelStageKey[];
  const days = (h: number | null) => (h === null ? '—' : h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(1)} days`);

  return (
    <>
      <PageHeader title="Funnel" description="Every stage, every person behind it.">
        <DateRangePicker timezone={data.timezone} />
      </PageHeader>

      <PageBody className="space-y-5">
        <SampleDataBanner page="funnel figures" />

        <Card padding="lg">
          <CardHeader title="Full funnel" subtitle={`${range.presetLabel} · ${range.resolvedLabel}`} icon={Filter} />
          <Funnel scorecard={scorecard} baseline={data.baseline} rangeLabel={range.resolvedLabel} rowHeight={44} />
        </Card>

        {/* ---- Conversion over time ---- */}
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] mb-3" style={{ color: 'var(--text-quaternary)' }}>
            Conversion over time · {data.trend.grain === 'week' ? 'Sun–Sat weeks' : 'days'}
            {comparison.range ? ` · faded = ${comparison.range.resolvedLabel}` : ''}
          </div>
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
        </div>

        {/* ---- Per-source table ---- */}
        <Card padding="lg">
          <CardHeader title="By source" subtitle="Volume says where leads come from; the last two columns say which ones are worth having." icon={Table2} />
          {scorecard.sources.length === 0 ? (
            <EmptyState title="No contacts in this period" />
          ) : (
            <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    {['Source', ...FUNNEL_STAGES.map((s) => s.label), 'Applied → enrolled', 'Consult show rate'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-quaternary)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scorecard.sources.map((s) => (
                    <tr key={s.source} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                        {s.source}
                      </td>
                      {stageKeys.map((k) => (
                        <td key={k} className="px-3 py-2 tabular" style={{ color: 'var(--text-secondary)' }}>
                          {s.counts[k]}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Badge variant={s.appliedToEnrolled === null ? 'neutral' : s.appliedToEnrolled >= 0.1 ? 'success' : s.appliedToEnrolled > 0 ? 'warning' : 'danger'} size="xs">
                          {formatPct(s.appliedToEnrolled)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 tabular" style={{ color: 'var(--text-secondary)' }}>
                        {formatPct(s.consultShowRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ---- Time in stage ---- */}
        <Card padding="lg">
          <CardHeader title="Time in stage" subtitle="How long people sat in a stage before moving on (moves inside the period)" icon={Hourglass} />
          {scorecard.timeInStage.length === 0 ? (
            <EmptyState title="No stage moves in this period" />
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
    <Suspense fallback={<PageBody><PageLoader /></PageBody>}>
      <FunnelTab />
    </Suspense>
  );
}
