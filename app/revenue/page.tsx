'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { Banknote, Repeat, AlertTriangle, Undo2 } from 'lucide-react';
import { Area, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Toast, Button } from '@/components';
import { ChartTooltip, ChartLegend } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { KpiDeltaTile } from '@/components/KpiDeltaTile';
import { PaymentsTable } from '@/components/PaymentsTable';
import { useScorecard } from '@/components/useScorecard';
import { computeDelta, formatCents } from '@/lib/metrics';

function RevenueTab() {
  const { data, loading, error } = useScorecard();

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Revenue" description="Real cash collected — never estimated." />
        <PageBody>
          <PageLoader label="Loading revenue" />
        </PageBody>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Revenue" />
        <PageBody>
          <EmptyState title="Could not load the scorecard" description={error ?? 'Unknown error'} />
        </PageBody>
      </>
    );
  }

  const { revenue, scorecard, comparison, range, trend } = data;
  const cmpLabel = comparison.range ? `${range.resolvedLabel} vs ${comparison.range.resolvedLabel}` : null;
  const weekly = trend.grain === 'week';

  const header = (
    <PageHeader title="Revenue" description="Real cash collected from Stripe, tied back to the cohort that produced it — never estimated.">
      <DateRangePicker timezone={data.timezone} />
    </PageHeader>
  );

  if (revenue.awaitingStripe) {
    return (
      <>
        {header}
        <PageBody className="space-y-5">
          <SampleDataBanner page="numbers" />
          <Card padding="lg">
            <EmptyState
              icon={<Banknote size={18} />}
              title="Connect Stripe"
              description="Add a restricted (read-only) key in Setup → Stripe. Real cash collected, recurring revenue, failed payments and refunds appear here — nothing is estimated, so this tab stays empty until then."
              action={
                <Link href="/setup">
                  <Button variant="primary">Open Setup</Button>
                </Link>
              }
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const trendRows = trend.current.map((p, i) => {
    const c = trend.comparison?.[i];
    return { label: p.label, revenue: p.revenueCents / 100, revenuePrev: c ? c.revenueCents / 100 : null };
  });
  const spark = trend.current.map((p) => p.revenueCents);

  return (
    <>
      {header}
      <PageBody className="space-y-5">
        <SampleDataBanner page="numbers" />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 stagger">
          <KpiDeltaTile
            label="Collected"
            value={formatCents(revenue.collectedCents, { compact: true })}
            delta={scorecard.kpis.revenueCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Banknote}
            accent="success"
            sparkline={spark}
            subtext={`${scorecard.revenue.paymentCount} successful payments, net of refunds`}
          />
          <KpiDeltaTile
            label="Recurring"
            value={formatCents(revenue.recurringCents, { compact: true })}
            delta={computeDelta(null, null)}
            deltaKind="cents"
            comparisonLabel={null}
            icon={Repeat}
            accent="accent"
            subtext={`${revenue.activeSubscriptions} active subscription${revenue.activeSubscriptions === 1 ? '' : 's'} · monthly`}
          />
          <KpiDeltaTile
            label="Failed"
            value={String(revenue.failedCount)}
            delta={computeDelta(revenue.failedCount, null, true)}
            comparisonLabel={cmpLabel}
            icon={AlertTriangle}
            accent="danger"
            subtext={revenue.failedCount > 0 ? `${formatCents(revenue.failedCents)} not collected` : 'nothing failed in period'}
          />
          <KpiDeltaTile
            label="Refunds"
            value={formatCents(revenue.refundedCents, { compact: true })}
            delta={computeDelta(revenue.refundedCents, null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Undo2}
            accent="warning"
            subtext={`${revenue.refundCount} refund${revenue.refundCount === 1 ? '' : 's'}`}
          />
        </div>

        <Card padding="lg">
          <CardHeader
            title={weekly ? 'Revenue trend · weekly (Sun–Sat)' : 'Revenue trend · daily'}
            subtitle={comparison.range ? `Dashed series = ${comparison.range.resolvedLabel}` : 'No comparison selected'}
            action={<ChartLegend items={[{ label: 'Collected ($)', color: 'var(--success)' }]} />}
          />
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trendRows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="revCollected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="revenue" name="Collected ($)" stroke="var(--success)" strokeWidth={2} fill="url(#revCollected)" />
              <Line type="monotone" dataKey="revenuePrev" name="Collected (comparison)" stroke="var(--success)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>

        <Card padding="lg">
          <CardHeader title="Payments" subtitle={`${range.presetLabel} · ${range.resolvedLabel} · failed payments pinned first`} icon={Banknote} />
          <PaymentsTable payments={revenue.payments} unmatchedCount={revenue.unmatchedCount} />
        </Card>
      </PageBody>

      <Toast isVisible={Boolean(error)} message="Could not refresh the scorecard" detail={error ?? undefined} type="error" onClose={() => undefined} />
    </>
  );
}

export default function RevenuePage() {
  return (
    <Suspense
      fallback={
        <PageBody>
          <PageLoader />
        </PageBody>
      }
    >
      <RevenueTab />
    </Suspense>
  );
}
