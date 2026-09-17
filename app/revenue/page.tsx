'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { Banknote, Repeat, AlertTriangle, Undo2, Sparkles, CalendarClock } from 'lucide-react';
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
  const prevRev = scorecard.kpis;

  const header = (
    <PageHeader
      title="Revenue"
      description="Real cash collected from Stripe, split into new-client (initial) and recurring — never estimated. Only initial cash feeds ROAS and CAC."
    >
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
    return {
      label: p.label,
      initial: p.initialCents / 100,
      recurring: p.recurringCents / 100,
      initialPrev: c ? c.initialCents / 100 : null,
    };
  });
  const sparkInitial = trend.current.map((p) => p.initialCents);
  const sparkRecurring = trend.current.map((p) => p.recurringCents);

  // The comparison period's recurring cash is not carried on the scorecard KPI
  // deltas; derive it from total − initial so the tile still gets a delta.
  const prevRecurring =
    prevRev.revenueCents.previous !== null && prevRev.initialCents.previous !== null ? prevRev.revenueCents.previous - prevRev.initialCents.previous : null;

  return (
    <>
      {header}
      <PageBody className="space-y-5">
        <SampleDataBanner page="numbers" />

        {revenue.unclassifiedCount > 0 && (
          <div
            className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px]"
            style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}
          >
            <AlertTriangle size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12.5px] leading-snug" style={{ color: 'var(--warning)' }}>
              <strong>{revenue.unclassifiedCount}</strong> succeeded payment{revenue.unclassifiedCount === 1 ? '' : 's'} (
              {formatCents(revenue.unclassifiedCents)}) in this period {revenue.unclassifiedCount === 1 ? 'has' : 'have'} no payment class yet, so{' '}
              {revenue.unclassifiedCount === 1 ? 'it is' : 'they are'} excluded from Initial and Recurring below. Run <code>npm run reclassify:payments</code> or
              a Stripe sync to classify.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 stagger">
          <KpiDeltaTile
            label="Initial cash"
            trendMetric="initial_cash"
            value={formatCents(revenue.initialCents, { compact: true })}
            delta={scorecard.kpis.initialCents}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Sparkles}
            accent="success"
            sparkline={sparkInitial}
            subtext={`${revenue.initialCount} new-client payment${revenue.initialCount === 1 ? '' : 's'} · net of refunds · feeds ROAS`}
          />
          <KpiDeltaTile
            label="Recurring cash"
            trendMetric="recurring_cash"
            value={formatCents(revenue.recurringCents, { compact: true })}
            delta={computeDelta(revenue.recurringCents, prevRecurring)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Repeat}
            accent="accent"
            sparkline={sparkRecurring}
            subtext={`${revenue.recurringCount} payment${revenue.recurringCount === 1 ? '' : 's'} from existing clients · excluded from ROAS`}
          />
          <KpiDeltaTile
            label="Subscriptions"
            value={formatCents(revenue.mrrCents, { compact: true })}
            delta={computeDelta(null, null)}
            deltaKind="cents"
            comparisonLabel={null}
            icon={CalendarClock}
            accent="info"
            subtext={`${revenue.activeSubscriptions} active · monthly-normalised plan value, not range-bound`}
          />
          <KpiDeltaTile
            label="Failed"
            trendMetric="failed"
            value={String(revenue.failedCount)}
            delta={computeDelta(revenue.failedCount, null, true)}
            comparisonLabel={cmpLabel}
            icon={AlertTriangle}
            accent="danger"
            subtext={revenue.failedCount > 0 ? `${formatCents(revenue.failedCents)} not collected` : 'nothing failed in period'}
          />
          <KpiDeltaTile
            label="Refunds"
            trendMetric="refunds"
            value={formatCents(revenue.refundedCents, { compact: true })}
            delta={computeDelta(revenue.refundedCents, null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Undo2}
            accent="warning"
            subtext={`${revenue.refundCount} refund${revenue.refundCount === 1 ? '' : 's'} · already netted out above`}
          />
        </div>

        <Card padding="lg">
          <CardHeader
            title={weekly ? 'Cash collected · weekly (Sun–Sat)' : 'Cash collected · daily'}
            subtitle={comparison.range ? `Dashed series = initial cash, ${comparison.range.resolvedLabel}` : 'No comparison selected'}
            action={
              <ChartLegend
                items={[
                  { label: 'Initial ($)', color: 'var(--success)' },
                  { label: 'Recurring ($)', color: 'var(--accent)' },
                ]}
              />
            }
          />
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trendRows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="revInitial" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="initial" name="Initial ($)" stroke="var(--success)" strokeWidth={2} fill="url(#revInitial)" />
              <Line type="monotone" dataKey="recurring" name="Recurring ($)" stroke="var(--accent)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="initialPrev" name="Initial (comparison)" stroke="var(--success)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>

        <Card padding="lg">
          <CardHeader
            title="Payments"
            subtitle={`${range.presetLabel} · ${range.resolvedLabel} · failed payments pinned first · filter by class to see initial vs recurring`}
            icon={Banknote}
          />
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
