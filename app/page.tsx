'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { DollarSign, Trophy, Target, TrendingUp, CalendarCheck, Scale, Map } from 'lucide-react';
import { Area, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, SampleDataBanner, EmptyState, Toast, SkeletonTile, SkeletonChart, Skeleton } from '@/components';
import { InsightsCard } from '@/components/InsightsCard';
import { ChartTooltip, ChartLegend } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { KpiDeltaTile } from '@/components/KpiDeltaTile';
import { FunnelStrip } from '@/components/FunnelStrip';
import { DataHealthNotice, marketingWarnings } from '@/components/DataHealth';
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
        <PageHeader title="Command Center" description="The 10-second read on the business — every number here comes from the same tested engine as the emails.">
          <DateRangePicker timezone="America/New_York" />
        </PageHeader>
        <PageBody className="space-y-5" aria-busy="true">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonTile key={i} />
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonTile key={i} />
            ))}
          </div>
          <div className="surface-raised rounded-[12px] px-4 py-3" style={{ minHeight: 90 }}>
            <Skeleton className="h-3 w-24 mb-3" />
            <div className="flex gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 flex-1" />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card padding="lg" className="lg:col-span-2">
              <Skeleton className="h-3 w-40 mb-4" />
              <SkeletonChart height={260} />
            </Card>
          </div>
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
  const { marketing } = scorecard;
  const cmpLabel = comparison.range ? `${range.resolvedLabel} vs ${comparison.range.resolvedLabel}` : null;
  const spark = (key: 'enrolled' | 'consultsBooked' | 'applied' | 'cacCents' | 'revenueCents' | 'initialCents') =>
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
        <DataHealthNotice items={marketingWarnings(marketing, scorecard.revenue)} />

        {/* ---- Row 1: Initial cash · Enrollments · Paid CAC · Blended CAC · ROAS ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 stagger">
          <KpiDeltaTile
            label="Initial cash collected"
            value={formatCents(scorecard.revenue.initialCents, { compact: true })}
            delta={scorecard.kpis.initialCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={DollarSign}
            accent="success"
            sparkline={spark('initialCents')}
            subtext={`${scorecard.revenue.initialCount} new-client payment${scorecard.revenue.initialCount === 1 ? '' : 's'} · net of refunds · recurring excluded`}
            empty={
              scorecard.revenue.awaitingStripe
                ? { title: 'Awaiting Stripe', description: 'New-client cash appears once the Stripe key is connected.' }
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
            subtext={`${marketing.paidEnrollments} paid · ${marketing.organicEnrollments} organic${marketing.unattributedEnrollments ? ` · ${marketing.unattributedEnrollments} unclassified` : ''}`}
          />
          <KpiDeltaTile
            label="Paid CAC"
            value={formatCents(marketing.paidCacCents)}
            delta={scorecard.kpis.paidCacCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Target}
            accent="warning"
            subtext={
              marketing.noSpendData ? (
                <Link href="/ads" style={{ color: 'var(--accent)' }}>
                  Enter weekly spend →
                </Link>
              ) : marketing.paidCacCents === null ? (
                'no paid-attributed enrollments in period'
              ) : (
                `${formatCents(marketing.spendCents, { compact: true })} spend ÷ ${marketing.paidEnrollments} paid enrolled`
              )
            }
          />
          <KpiDeltaTile
            label="Blended CAC"
            value={formatCents(marketing.blendedCacCents)}
            delta={scorecard.kpis.blendedCacCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Target}
            accent="info"
            sparkline={weekly ? spark('cacCents') : undefined}
            subtext={
              marketing.noSpendData ? (
                <Link href="/ads" style={{ color: 'var(--accent)' }}>
                  Enter weekly spend →
                </Link>
              ) : marketing.blendedCacCents === null ? (
                'no enrollments in period'
              ) : (
                `${formatCents(marketing.spendCents, { compact: true })} spend ÷ ${marketing.enrollments} enrolled (organic included)`
              )
            }
          />
          <KpiDeltaTile
            label="ROAS"
            value={marketing.roas !== null ? `${marketing.roas.toFixed(2)}×` : '—'}
            delta={scorecard.kpis.roas}
            deltaKind="ratio"
            comparisonLabel={cmpLabel}
            icon={TrendingUp}
            accent="success"
            subtext={
              marketing.roas === null
                ? marketing.noSpendData
                  ? 'no spend in period'
                  : 'paid initial cash ÷ ad spend'
                : `${formatCents(marketing.paidInitialCents, { compact: true })} paid initial cash ÷ ${formatCents(marketing.spendCents, { compact: true })} spend`
            }
            empty={
              scorecard.revenue.awaitingStripe
                ? { title: 'Awaiting Stripe', description: 'ROAS needs real revenue. Spend is tracked already.' }
                : undefined
            }
          />
        </div>

        {/* ---- Row 2: LTV:CAC · Consults booked · Cost per roadmap booked ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 stagger">
          <KpiDeltaTile
            label="LTV:CAC"
            value={marketing.ltvToCac !== null ? `${marketing.ltvToCac.toFixed(1)}×` : '—'}
            delta={scorecard.kpis.ltvToCac}
            deltaKind="ratio"
            comparisonLabel={cmpLabel}
            icon={Scale}
            accent="accent"
            subtext={
              marketing.ltvToCac !== null
                ? `${formatCents(marketing.contractValueCents, { compact: true })} contract value of ${marketing.enrollments} new client${marketing.enrollments === 1 ? '' : 's'} ÷ ${formatCents(marketing.spendCents, { compact: true })} spend`
                : 'avg contract value ÷ blended CAC'
            }
            empty={
              marketing.contractValueMissing.length > 0
                ? {
                    title: 'Contract value missing',
                    description: `${marketing.contractValueMissing.length} new client${marketing.contractValueMissing.length === 1 ? ' has' : 's have'} no opportunity value in GHL — see the notice above.`,
                  }
                : marketing.enrollments === 0
                  ? { title: 'No new clients', description: 'LTV:CAC needs at least one enrollment in the period.' }
                  : marketing.noSpendData
                    ? { title: 'No spend', description: 'LTV:CAC needs ad spend for the period.' }
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
          <KpiDeltaTile
            label="Cost per roadmap booked"
            value={formatCents(marketing.costPerRoadmapCents)}
            delta={scorecard.kpis.costPerRoadmapCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Map}
            accent="info"
            subtext={
              marketing.costPerRoadmapCents === null
                ? marketing.noSpendData
                  ? 'no spend in period'
                  : 'no roadmaps booked in period'
                : `${formatCents(marketing.spendCents, { compact: true })} spend ÷ ${scorecard.kpis.roadmapsBooked.current ?? 0} roadmaps booked`
            }
          />
        </div>

        {/* ---- Funnel summary strip (the deep-dive lives on /funnel) ---- */}
        <FunnelStrip scorecard={scorecard} href={`/funnel?${search.toString()}`} rangeLabel={`${range.presetLabel} · ${range.resolvedLabel}`} />

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
                    ...(weekly ? [{ label: 'Blended CAC ($)', color: 'var(--warning)' }] : []),
                  ]}
                />
              }
            />
            {trendRows.every((r) => r.applied === 0 && r.enrolled === 0) ? (
              <EmptyState
                compact
                title="Nothing happened in this range"
                description="No applications or enrollments were observed — try Last 30 days, or run a sync from Setup."
              />
            ) : (
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
                  <Line yAxisId="money" type="monotone" dataKey="cac" name="Blended CAC ($)" stroke="var(--warning)" strokeWidth={1.8} dot={false} connectNulls />
                )}
              </ComposedChart>
            </ResponsiveContainer>
            )}
          </Card>

          <InsightsCard rangeKey={`${range.start}:${range.end}:${comparison.mode}`} />
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
        <PageBody className="space-y-5" aria-busy="true">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonTile key={i} />
            ))}
          </div>
          <SkeletonChart height={260} />
        </PageBody>
      }
    >
      <CommandCenter />
    </Suspense>
  );
}
