'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  Users,
  CalendarCheck,
  TrendingUp,
  UserX,
  Repeat,
  Target,
  Trophy,
  Radio,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  Badge,
  KPITile,
  Button,
  PageHeader,
  PageBody,
  SampleDataBanner,
  PageLoader,
  EmptyState,
} from '@/components';
import { ChartTooltip, ChartLegend, MetricBar, CATEGORICAL } from '@/components/Chart';

interface Derived {
  total: number;
  marked: number;
  booked: number;
  noShow: number;
  notContinuing: number;
  attended: number;
  showRate: number;
  rebookRate: number;
  noShowRate: number;
}

interface MetricsData {
  range: { days: number; start: string; end: string; timezone: string };
  overall: Derived;
  comparison: {
    showRate: number;
    rebookRate: number;
    noShowRate: number;
    volume: number;
  };
  trend: Array<{
    date: string;
    label: string;
    total: number;
    booked: number;
    noShow: number;
    notContinuing: number;
    showRate: number | null;
    rebookRate: number | null;
  }>;
  weekly: Array<{
    label: string;
    booked: number;
    noShow: number;
    notContinuing: number;
    showRate: number;
    rebookRate: number;
  }>;
  sourcePerformance: Array<{ source: string } & Derived>;
  sourceVolume: Array<{ source: string; count: number; share: number }>;
  typePerformance: Array<{ type: string } & Derived>;
  ownerPerformance: Array<{ owner: string } & Derived>;
  funnel: Array<{ stage: string; count: number; value: number }>;
  totalLeads: number;
  totalPipelineValue: number;
}

const RANGES = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

export default function MetricsPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/metrics?days=${range}`);
      setData(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Metrics" description="Pipeline performance and lead source analysis" />
        <PageBody>
          <PageLoader label="Crunching numbers" />
        </PageBody>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Metrics" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<TrendingUp size={19} />}
              title="No metrics available"
              description="Once appointments have outcomes recorded, trends will appear here."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const fmtDelta = (n: number, suffix = 'pt') =>
    `${n > 0 ? '+' : ''}${n}${suffix}`;

  // Sparkline series for the KPI tiles.
  const showRateSeries = data.trend
    .map((t) => t.showRate)
    .filter((v): v is number => v !== null);
  const rebookSeries = data.trend
    .map((t) => t.rebookRate)
    .filter((v): v is number => v !== null);
  const volumeSeries = data.trend.map((t) => t.total);

  // Only sources with enough appointments to mean anything.
  const rankedSources = data.sourcePerformance.filter((s) => s.marked >= 3);
  const bestSource = [...rankedSources].sort((a, b) => b.rebookRate - a.rebookRate)[0];
  const maxSourceVolume = Math.max(...data.sourceVolume.map((s) => s.count), 1);
  const maxFunnel = Math.max(...data.funnel.map((f) => f.count), 1);

  return (
    <>
      <PageHeader
        title="Metrics"
        description={`Performance across the last ${data.range.days} days — where leads come from, and what actually converts.`}
        actions={
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-[8px]"
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className="h-[26px] px-2.5 rounded-[6px] text-[12px] font-medium transition-all duration-150"
                style={
                  days === r.days
                    ? {
                        background: 'var(--surface)',
                        color: 'var(--text-primary)',
                        boxShadow: 'var(--shadow-xs)',
                      }
                    : { color: 'var(--text-tertiary)' }
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <PageBody className="space-y-5">
        <SampleDataBanner page="metrics" />
        {/* ---- Headline KPIs ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger">
          <KPITile
            label="Show Rate"
            value={`${data.overall.showRate}%`}
            subtext={`${data.overall.attended} of ${data.overall.marked} attended`}
            icon={CalendarCheck}
            accent="success"
            trend={data.comparison.showRate === 0 ? 'flat' : data.comparison.showRate > 0 ? 'up' : 'down'}
            trendValue={fmtDelta(data.comparison.showRate)}
            sparkline={showRateSeries}
          />
          <KPITile
            label="Rebook Rate"
            value={`${data.overall.rebookRate}%`}
            subtext="Of those who showed up"
            icon={Repeat}
            accent="accent"
            trend={data.comparison.rebookRate === 0 ? 'flat' : data.comparison.rebookRate > 0 ? 'up' : 'down'}
            trendValue={fmtDelta(data.comparison.rebookRate)}
            sparkline={rebookSeries}
          />
          <KPITile
            label="No-Show Rate"
            value={`${data.overall.noShowRate}%`}
            subtext={`${data.overall.noShow} missed appointments`}
            icon={UserX}
            accent="warning"
            trend={data.comparison.noShowRate === 0 ? 'flat' : data.comparison.noShowRate > 0 ? 'up' : 'down'}
            trendValue={fmtDelta(data.comparison.noShowRate)}
            // A rising no-show rate is bad news, so invert the colour logic.
            trendIsGood={false}
          />
          <KPITile
            label="Appointments"
            value={data.overall.total}
            subtext={`${data.totalLeads} leads in pipeline`}
            icon={Users}
            accent="info"
            trend={data.comparison.volume === 0 ? 'flat' : data.comparison.volume > 0 ? 'up' : 'down'}
            trendValue={fmtDelta(data.comparison.volume, '')}
            sparkline={volumeSeries}
          />
        </div>

        {/* ---- Outcome trend ---- */}
        <Card padding="lg">
          <CardHeader
            title="Outcomes over time"
            subtitle="Daily appointment results across the selected range"
            icon={TrendingUp}
            action={
              <ChartLegend
                items={[
                  { label: 'Booked', color: 'var(--success)' },
                  { label: 'Not continuing', color: 'var(--danger)' },
                  { label: 'No show', color: 'var(--warning)' },
                ]}
              />
            }
          />

          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data.trend} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
              <defs>
                <linearGradient id="gBooked" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--success)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gNotCont" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--danger)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gNoShow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--warning)" stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />

              <Area
                type="monotone"
                dataKey="booked"
                name="Booked"
                stackId="1"
                stroke="var(--success)"
                strokeWidth={1.8}
                fill="url(#gBooked)"
              />
              <Area
                type="monotone"
                dataKey="notContinuing"
                name="Not continuing"
                stackId="1"
                stroke="var(--danger)"
                strokeWidth={1.8}
                fill="url(#gNotCont)"
              />
              <Area
                type="monotone"
                dataKey="noShow"
                name="No show"
                stackId="1"
                stroke="var(--warning)"
                strokeWidth={1.8}
                fill="url(#gNoShow)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* ---- Rate trend + source mix ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <Card padding="lg" className="lg:col-span-3">
            <CardHeader
              title="Show rate vs. rebook rate"
              subtitle="Turning up and continuing are separate problems — tracked separately"
              icon={Target}
              action={
                <ChartLegend
                  items={[
                    { label: 'Show rate', color: 'var(--info)' },
                    { label: 'Rebook rate', color: 'var(--accent)' },
                  ]}
                />
              }
            />

            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={data.trend} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip content={<ChartTooltip suffix="%" />} />

                <Line
                  type="monotone"
                  dataKey="showRate"
                  name="Show rate"
                  stroke="var(--info)"
                  strokeWidth={2.2}
                  connectNulls
                  dot={false}
                  activeDot={{ r: 3.5, strokeWidth: 0 }}
                />
                <Line
                  type="monotone"
                  dataKey="rebookRate"
                  name="Rebook rate"
                  stroke="var(--accent)"
                  strokeWidth={2.2}
                  connectNulls
                  dot={false}
                  activeDot={{ r: 3.5, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card padding="lg" className="lg:col-span-2">
            <CardHeader
              title="Where leads come from"
              subtitle="Share of total pipeline"
              icon={Radio}
            />

            <div className="flex items-center gap-4">
              <ResponsiveContainer width="55%" height={190}>
                <PieChart>
                  <Pie
                    data={data.sourceVolume}
                    dataKey="count"
                    nameKey="source"
                    innerRadius={42}
                    outerRadius={72}
                    paddingAngle={2.5}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  >
                    {data.sourceVolume.map((entry, i) => (
                      <Cell key={entry.source} fill={CATEGORICAL[i % CATEGORICAL.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>

              <div className="flex-1 flex flex-col gap-2 min-w-0">
                {data.sourceVolume.slice(0, 6).map((s, i) => (
                  <div key={s.source} className="flex items-center gap-2 min-w-0">
                    <span
                      className="rounded-[2px] shrink-0"
                      style={{
                        width: 8,
                        height: 8,
                        background: CATEGORICAL[i % CATEGORICAL.length],
                      }}
                    />
                    <span
                      className="text-[12px] truncate flex-1"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {s.source}
                    </span>
                    <span
                      className="text-[12px] font-semibold tabular shrink-0"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {s.share}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* ---- Source effectiveness ---- */}
        <Card padding="lg">
          <CardHeader
            title="Which sources actually convert"
            subtitle="Volume tells you where leads come from. Rebook rate tells you which ones are worth having."
            icon={Trophy}
            action={
              bestSource && (
                <Badge variant="success" size="md" dot>
                  Best: {bestSource.source} · {bestSource.rebookRate}%
                </Badge>
              )
            }
          />

          {rankedSources.length === 0 ? (
            <EmptyState
              title="Not enough data yet"
              description="Sources appear here once they have at least 3 marked appointments."
            />
          ) : (
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {['Source', 'Leads', 'Appts', 'Show rate', 'Rebook rate', 'Outcome mix'].map(
                      (h, i) => (
                        <th
                          key={h}
                          className={`pb-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${i === 0 ? 'text-left' : 'text-right'} ${h === 'Outcome mix' ? 'text-left pl-6' : ''}`}
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rankedSources.map((s, i) => {
                    const volume =
                      data.sourceVolume.find((v) => v.source === s.source)?.count ?? 0;
                    const color = CATEGORICAL[i % CATEGORICAL.length];

                    return (
                      <tr
                        key={s.source}
                        className="group transition-colors hover:bg-[var(--surface-hover)]"
                        style={{ borderBottom: '1px solid var(--border-subtle)' }}
                      >
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="rounded-[3px] shrink-0"
                              style={{ width: 8, height: 8, background: color }}
                            />
                            <span
                              className="text-[13px] font-medium"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              {s.source}
                            </span>
                          </div>
                        </td>
                        <td
                          className="py-3 text-right text-[13px] tabular"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {volume}
                        </td>
                        <td
                          className="py-3 text-right text-[13px] tabular"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {s.marked}
                        </td>
                        <td className="py-3 text-right">
                          <span
                            className="text-[13px] font-semibold tabular"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {s.showRate}%
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <Badge
                            variant={
                              s.rebookRate >= 60
                                ? 'success'
                                : s.rebookRate >= 40
                                  ? 'warning'
                                  : 'danger'
                            }
                          >
                            {s.rebookRate}%
                          </Badge>
                        </td>
                        <td className="py-3 pl-6" style={{ width: '30%' }}>
                          <div className="flex items-center gap-2">
                            <div
                              className="flex-1 flex h-[6px] rounded-full overflow-hidden"
                              style={{ background: 'var(--surface-sunken)' }}
                            >
                              <div
                                style={{
                                  width: `${(s.booked / Math.max(s.marked, 1)) * 100}%`,
                                  background: 'var(--success)',
                                }}
                              />
                              <div
                                style={{
                                  width: `${(s.notContinuing / Math.max(s.marked, 1)) * 100}%`,
                                  background: 'var(--danger)',
                                }}
                              />
                              <div
                                style={{
                                  width: `${(s.noShow / Math.max(s.marked, 1)) * 100}%`,
                                  background: 'var(--warning)',
                                }}
                              />
                            </div>
                            <span
                              className="text-[11px] tabular shrink-0 w-[68px] text-right"
                              style={{ color: 'var(--text-quaternary)' }}
                            >
                              {s.booked}/{s.notContinuing}/{s.noShow}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ---- Type + owner ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card padding="lg">
            <CardHeader
              title="Rebook rate by appointment type"
              subtitle="Which conversations move people forward"
              icon={Repeat}
            />

            <ResponsiveContainer width="100%" height={210}>
              <BarChart
                data={data.typePerformance}
                margin={{ top: 4, right: 4, left: -22, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="type" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  content={<ChartTooltip suffix="%" />}
                  cursor={{ fill: 'var(--surface-hover)' }}
                />
                <Bar dataKey="rebookRate" name="Rebook rate" radius={[5, 5, 0, 0]} maxBarSize={54}>
                  {data.typePerformance.map((entry, i) => (
                    <Cell key={entry.type} fill={CATEGORICAL[i % CATEGORICAL.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card padding="lg">
            <CardHeader
              title="Rep performance"
              subtitle="Ranked by rebook rate"
              icon={Trophy}
            />

            <div className="flex flex-col gap-3.5 pt-1">
              {data.ownerPerformance.map((o, i) => (
                <div key={o.owner}>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-[20px] w-[20px] grid place-items-center rounded-[5px] text-[10.5px] font-bold shrink-0"
                        style={{
                          background: i === 0 ? 'var(--accent-muted)' : 'var(--surface-hover)',
                          color: i === 0 ? 'var(--accent)' : 'var(--text-tertiary)',
                        }}
                      >
                        {i + 1}
                      </span>
                      <span
                        className="text-[13px] font-medium truncate"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {o.owner}
                      </span>
                      <span
                        className="text-[11.5px] tabular shrink-0"
                        style={{ color: 'var(--text-quaternary)' }}
                      >
                        {o.marked} appts
                      </span>
                    </div>
                    <span
                      className="text-[13px] font-semibold tabular shrink-0"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {o.rebookRate}%
                    </span>
                  </div>
                  <MetricBar
                    value={o.rebookRate}
                    color={i === 0 ? 'var(--accent)' : 'var(--text-quaternary)'}
                  />
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ---- Funnel ---- */}
        <Card padding="lg">
          <CardHeader
            title="Pipeline distribution"
            subtitle="Where every lead currently sits"
            icon={Users}
            action={
              <span className="text-[12px] tabular" style={{ color: 'var(--text-tertiary)' }}>
                {data.totalLeads} leads · $
                {(data.totalPipelineValue / 100).toLocaleString()} value
              </span>
            }
          />

          <div className="flex flex-col gap-2.5">
            {data.funnel.map((f) => (
              <div key={f.stage} className="flex items-center gap-3">
                <span
                  className="text-[12.5px] w-[190px] shrink-0 truncate"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {f.stage}
                </span>

                <div className="flex-1 flex items-center gap-2.5">
                  <div
                    className="flex-1 rounded-[5px] overflow-hidden"
                    style={{ height: 24, background: 'var(--surface-sunken)' }}
                  >
                    <div
                      className="h-full rounded-[5px] transition-all duration-700 ease-out flex items-center px-2"
                      style={{
                        width: `${(f.count / maxFunnel) * 100}%`,
                        background:
                          f.stage === 'Enrolled'
                            ? 'var(--success)'
                            : f.stage.includes('No Show')
                              ? 'var(--warning)'
                              : f.stage.includes('Objection')
                                ? 'var(--danger)'
                                : 'var(--accent)',
                        opacity: f.count === 0 ? 0.25 : 1,
                      }}
                    >
                      {f.count > 0 && (
                        <span className="text-[11px] font-semibold text-white tabular">
                          {f.count}
                        </span>
                      )}
                    </div>
                  </div>

                  <span
                    className="text-[11.5px] tabular w-[74px] text-right shrink-0"
                    style={{ color: 'var(--text-quaternary)' }}
                  >
                    ${(f.value / 100).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* ---- Weekly rollup ---- */}
        {data.weekly.length > 1 && (
          <Card padding="lg">
            <CardHeader
              title="Week over week"
              subtitle="Smoothed view — daily numbers are noisy at this volume"
              icon={TrendingUp}
              action={
                <ChartLegend
                  items={[
                    { label: 'Show rate', color: 'var(--info)' },
                    { label: 'Rebook rate', color: 'var(--accent)' },
                  ]}
                />
              }
            />

            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.weekly} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  content={<ChartTooltip suffix="%" />}
                  cursor={{ fill: 'var(--surface-hover)' }}
                />
                <Bar dataKey="showRate" name="Show rate" fill="var(--info)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                <Bar dataKey="rebookRate" name="Rebook rate" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </PageBody>
    </>
  );
}
