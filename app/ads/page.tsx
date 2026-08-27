'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { DollarSign, Users, CalendarCheck, Target, TrendingUp, Megaphone } from 'lucide-react';
import { Area, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ComposedChart } from 'recharts';
import { Card, CardHeader, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Toast, Button } from '@/components';
import { ChartTooltip, ChartLegend } from '@/components/Chart';
import { DateRangePicker } from '@/components/DateRangePicker';
import { KpiDeltaTile } from '@/components/KpiDeltaTile';
import { CampaignTable } from '@/components/CampaignTable';
import { SpendEntry } from '@/components/SpendEntry';
import { useScorecard } from '@/components/useScorecard';
import { computeDelta, formatCents } from '@/lib/metrics';

function AdsTab() {
  const { data, loading, error } = useScorecard();

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Ads" description="Spend, cost per stage and what each campaign actually produced." />
        <PageBody>
          <PageLoader label="Computing ad economics" />
        </PageBody>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Ads" />
        <PageBody>
          <EmptyState title="Could not load the scorecard" description={error ?? 'Unknown error'} />
        </PageBody>
      </>
    );
  }

  const { ads, revenue, comparison, range, trend } = data;
  const { kpis, previousKpis } = ads;
  const cmpLabel = comparison.range ? `${range.resolvedLabel} vs ${comparison.range.resolvedLabel}` : null;
  const weekly = trend.grain === 'week';

  const trendRows = trend.current.map((p, i) => {
    const c = trend.comparison?.[i];
    return {
      label: p.label,
      spend: p.spendCents / 100,
      revenue: revenue.awaitingStripe ? null : p.revenueCents / 100,
      spendPrev: c ? c.spendCents / 100 : null,
      revenuePrev: c && !revenue.awaitingStripe ? c.revenueCents / 100 : null,
    };
  });
  const spark = (key: 'spendCents' | 'revenueCents') => trend.current.map((p) => p[key]);

  return (
    <>
      <PageHeader title="Ads" description="Spend, cost per stage and what each campaign actually produced — platform numbers beside FitFlow-tracked ones.">
        <DateRangePicker timezone={data.timezone} />
      </PageHeader>

      <PageBody className="space-y-5">
        <SampleDataBanner page="numbers" />

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 stagger">
          <KpiDeltaTile
            label="Spend"
            value={formatCents(kpis.spendCents, { compact: true })}
            delta={computeDelta(kpis.spendCents, previousKpis?.spendCents ?? null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={DollarSign}
            accent="warning"
            sparkline={spark('spendCents')}
            subtext={kpis.byPlatform.map((p) => `${p.platform} ${formatCents(p.spendCents, { compact: true })}`).join(' · ') || 'no spend recorded'}
          />
          <KpiDeltaTile
            label="Cost per lead"
            value={formatCents(kpis.costPerLeadCents)}
            delta={computeDelta(kpis.costPerLeadCents, previousKpis?.costPerLeadCents ?? null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Users}
            accent="info"
            subtext="spend ÷ applied"
          />
          <KpiDeltaTile
            label="Cost per consult"
            value={formatCents(kpis.costPerConsultCents)}
            delta={computeDelta(kpis.costPerConsultCents, previousKpis?.costPerConsultCents ?? null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={CalendarCheck}
            accent="accent"
            subtext="spend ÷ consults booked"
          />
          <KpiDeltaTile
            label="Cost per client"
            value={formatCents(kpis.cacCents)}
            delta={computeDelta(kpis.cacCents, previousKpis?.cacCents ?? null, true)}
            deltaKind="cents"
            comparisonLabel={cmpLabel}
            icon={Target}
            accent="warning"
            subtext={kpis.cacCents === null ? 'no enrollments in period' : 'spend ÷ enrolled'}
          />
          <KpiDeltaTile
            label="ROAS"
            value={kpis.roas !== null ? `${kpis.roas.toFixed(2)}×` : '—'}
            delta={computeDelta(kpis.roas, previousKpis?.roas ?? null)}
            deltaKind="ratio"
            comparisonLabel={cmpLabel}
            icon={TrendingUp}
            accent="success"
            subtext="revenue ÷ ad spend"
            empty={kpis.awaitingStripe ? { title: 'Awaiting Stripe', description: 'ROAS needs real revenue. Connect Stripe in Setup.' } : undefined}
          />
        </div>

        <Card padding="lg">
          <CardHeader
            title={weekly ? 'Spend vs revenue · weekly (Sun–Sat)' : 'Spend vs revenue · daily'}
            subtitle={
              revenue.awaitingStripe
                ? 'Revenue series hidden until Stripe is connected — spend only.'
                : comparison.range
                  ? `Dashed series = ${comparison.range.resolvedLabel}`
                  : 'No comparison selected'
            }
            action={
              <ChartLegend
                items={[
                  { label: 'Spend ($)', color: 'var(--warning)' },
                  ...(revenue.awaitingStripe ? [] : [{ label: 'Revenue ($)', color: 'var(--success)' }]),
                ]}
              />
            }
          />
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trendRows} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="adsSpend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--warning)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--grid-line)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-quaternary)' }} />
              <Tooltip content={<ChartTooltip suffix="" />} />
              <Area type="monotone" dataKey="spend" name="Spend ($)" stroke="var(--warning)" strokeWidth={2} fill="url(#adsSpend)" />
              <Line type="monotone" dataKey="spendPrev" name="Spend (comparison)" stroke="var(--warning)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
              {!revenue.awaitingStripe && (
                <>
                  <Line type="monotone" dataKey="revenue" name="Revenue ($)" stroke="var(--success)" strokeWidth={2.2} dot={false} />
                  <Line type="monotone" dataKey="revenuePrev" name="Revenue (comparison)" stroke="var(--success)" strokeWidth={1.4} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </Card>

        {!kpis.apiConnected && (
          <Card padding="lg">
            <EmptyState
              icon={<Megaphone size={18} />}
              title="Connect Meta Ads"
              description="Paste a token in Setup → Meta Ads and campaigns appear here with spend, impressions, clicks and platform leads beside FitFlow-tracked results. Until then, weekly manual spend powers the cost metrics."
              action={
                <Link href="/setup">
                  <Button variant="primary">Open Setup</Button>
                </Link>
              }
            />
          </Card>
        )}

        <Card padding="lg">
          <CardHeader
            title="Campaigns"
            subtitle={`${range.presetLabel} · ${range.resolvedLabel} · FitFlow-tracked counts join contacts to campaigns by utm_campaign`}
            icon={Megaphone}
          />
          <CampaignTable campaigns={ads.campaigns} previous={ads.previousCampaigns} comparisonLabel={cmpLabel} />
        </Card>

        <Card padding="lg">
          <CardHeader
            title="Manual weekly spend"
            subtitle="Lives here now. Weekly amounts are spread across the week and used only for days Meta/Google have not reported."
            icon={DollarSign}
          />
          <SpendEntry />
        </Card>
      </PageBody>

      <Toast isVisible={Boolean(error)} message="Could not refresh the scorecard" detail={error ?? undefined} type="error" onClose={() => undefined} />
    </>
  );
}

export default function AdsPage() {
  return (
    <Suspense
      fallback={
        <PageBody>
          <PageLoader />
        </PageBody>
      }
    >
      <AdsTab />
    </Suspense>
  );
}
