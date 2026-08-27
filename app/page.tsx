'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { DollarSign, Trophy, Target, TrendingUp, CalendarCheck, Sparkles } from 'lucide-react';
import { Area, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Toast } from '@/components';
import { ChartTooltip, ChartLegend } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { KpiDeltaTile } from '@/components/KpiDeltaTile';
import { Funnel } from '@/components/Funnel';
import { useScorecard } from '@/components/useScorecard';
import { formatCents } from '@/lib/metrics';

function CommandCenter() {
  const { data, loading, error } = useScorecard();
  const search = useSearchParams();

  const trendRows = (data?.trend.current ?? []).map((p, i) => {
      const c = data!.trend.comparison?.[i];
      return {
        label: p.label,
        applied: p.applied,
        enrolled: p.enrolled,
        cac: p.cacCents !== null ? Math.round(p.cacCents / 100) : null,
        appliedPrev: c?.applied ?? null,
        enrolledPrev: c?.enrolled ?? null,
      };
    });

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Command Center" description="The 10-second read on the business." />
        <PageBody>
          <PageLoader label="Computing scorecard" />
        </PageBody>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Command Center" />
        <PageBody>
          <EmptyState title="Could not load the scorecard" description={error ?? 'Unknown error'} />
        </PageBody>
      </>
    );
  }

  const { scorecard, comparison, range, trend } = data;
  const cmpLabel = comparison.range ? `${range.resolvedLabel} vs ${comparison.range.resolvedLabel}` : null;
  const spark = (key: 'enrolled' | 'consultsBooked' | 'applied' | 'cacCents' | 'revenueCents') =>
    trend.current.map((p) => (p[key] as number | null) ?? 0);
  const weekly = trend.grain === 'week';

  return (
    <>
      <PageHeader
        title="Command Center"
        description="The 10-second read on the business — every number here comes from the same tested engine as the emails."
      >
        <DateRangePicker timezone={data.timezone} />
      </PageHeader>

      <PageBody className="space-y-5">
        <SampleDataBanner page="numbers" />

        {/* ---- 5 pinned KPIs ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 stagger">
          <KpiDeltaTile
            label="Revenue collected"
            value={formatCents(scorecard.revenue.collectedCents, { compact: true })}
            delta={scorecard.kpis.revenueCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={DollarSign}
            accent="success"
            sparkline={spark('revenueCents')}
            subtext={`${scorecard.revenue.paymentCount} payments`}
            empty={
              scorecard.revenue.awaitingStripe
                ? { title: 'Awaiting Stripe', description: 'Real cash collected appears once the Stripe key is connected (Phase C).' }
                : undefined
            }
          />
          <KpiDeltaTile
            label="Enrollments"
            value={String(scorecard.kpis.enrollments.current ?? 0)}
            delta={scorecard.kpis.enrollments}
            comparisonLabel={cmpLabel}
            icon={Trophy}
            accent="accent"
            sparkline={spark('enrolled')}
            subtext={comparison.range ? `${scorecard.kpis.enrollments.previous ?? 0} in ${comparison.range.resolvedLabel}` : 'new clients in period'}
          />
          <KpiDeltaTile
            label="Cost per client"
            value={formatCents(scorecard.cac.cacCents)}
            delta={scorecard.kpis.cacCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Target}
            accent="warning"
            sparkline={weekly ? spark('cacCents') : undefined}
            subtext={
              scorecard.cac.noSpendData ? (
                <Link href="/ads" style={{ color: 'var(--accent)' }}>
                  Enter weekly spend →
                </Link>
              ) : scorecard.cac.cacCents === null ? (
                'no enrollments in period'
              ) : (
                `${formatCents(scorecard.cac.spendCents, { compact: true })} spend ÷ ${scorecard.cac.enrollments} enrolled`
              )
            }
          />
          <KpiDeltaTile
            label="ROAS"
            value={scorecard.revenue.roas !== null ? `${scorecard.revenue.roas.toFixed(2)}×` : '—'}
            delta={scorecard.kpis.roas}
            deltaKind="ratio"
            comparisonLabel={cmpLabel}
            icon={TrendingUp}
            accent="info"
            subtext="revenue ÷ ad spend"
            empty={
              scorecard.revenue.awaitingStripe
                ? { title: 'Awaiting Stripe', description: 'ROAS needs real revenue. Spend is tracked already.' }
                : undefined
            }
          />
          <KpiDeltaTile
            label="Consults booked"
            value={String(scorecard.kpis.consultsBooked.current ?? 0)}
            delta={scorecard.kpis.consultsBooked}
            comparisonLabel={cmpLabel}
            icon={CalendarCheck}
            accent="accent"
            sparkline={spark('consultsBooked')}
            subtext={`${scorecard.kpis.applied.current ?? 0} applied`}
          />
        </div>

        {/* ---- Funnel, full width ---- */}
        <Card padding="lg">
          <CardHeader
            title="Funnel"
            subtitle={`${range.presetLabel} · ${range.resolvedLabel}`}
            action={
              <Link href={`/funnel?${search.toString()}`} className="text-[12.5px] font-medium" style={{ color: 'var(--accent)' }}>
                Funnel deep-dive →
              </Link>
            }
          />
          <Funnel scorecard={scorecard} baseline={data.baseline} rangeLabel={range.resolvedLabel} />
        </Card>

        {/* ---- Trend + insights ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card padding="lg" className="lg:col-span-2">
            <CardHeader
              title={weekly ? 'Weekly trend (Sun–Sat)' : 'Daily trend'}
              subtitle={comparison.range ? `Dashed series = ${comparison.range.resolvedLabel}` : 'No comparison selected'}
              action={
                <ChartLegend
                  items={[
                    { label: 'Applied', color: 'var(--info)' },
                    { label: 'Enrolled', color: 'var(--accent)' },
                    ...(weekly ? [{ label: 'Cost per client ($)', color: 'var(--warning)' }] : []),
                  ]}
                />
              }
            />
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={trendRows} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="ccApplied" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--info)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--info)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
                <YAxis yAxisId="count" tickLine={false} axisLine={false} allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
                {weekly && (
                  <YAxis yAxisId="money" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
                )}
                <Tooltip content={<ChartTooltip />} />
                <Area yAxisId="count" type="monotone" dataKey="applied" name="Applied" stroke="var(--info)" strokeWidth={2} fill="url(#ccApplied)" />
                <Line yAxisId="count" type="monotone" dataKey="appliedPrev" name="Applied (comparison)" stroke="var(--info)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
                <Line yAxisId="count" type="monotone" dataKey="enrolled" name="Enrolled" stroke="var(--accent)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="count" type="monotone" dataKey="enrolledPrev" name="Enrolled (comparison)" stroke="var(--accent)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
                {weekly && (
                  <Line yAxisId="money" type="monotone" dataKey="cac" name="Cost per client ($)" stroke="var(--warning)" strokeWidth={1.8} dot={false} connectNulls />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </Card>

          <Card padding="lg">
            <CardHeader title="Insights" subtitle="Max three specific findings" icon={Sparkles} />
            <EmptyState icon={<Sparkles size={18} />} title="AI insights arrive in Phase D" description="This card stays quiet until there is something specific to say." />
          </Card>
        </div>
      </PageBody>

      <Toast isVisible={Boolean(error)} message="Could not refresh the scorecard" detail={error ?? undefined} type="error" onClose={() => undefined} />
    </>
  );
}

export default function CommandCenterPage() {
  return (
    <Suspense
      fallback={
        <PageBody>
          <PageLoader />
        </PageBody>
      }
    >
      <CommandCenter />
    </Suspense>
  );
}
