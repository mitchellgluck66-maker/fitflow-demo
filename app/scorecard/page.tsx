'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banknote, Filter, Megaphone, Sparkles, Trophy, Frown, ArrowRight, CalendarRange, CalendarDays } from 'lucide-react';
import { Card, CardHeader, PageHeader, PageBody, SampleDataBanner, EmptyState, Toast, SkeletonTile, Skeleton, Badge } from '@/components';
import { DateRangePicker } from '@/components/DateRangePicker';
import { KpiDeltaTile } from '@/components/KpiDeltaTile';
import { FunnelStrip } from '@/components/FunnelStrip';
import { formatCents } from '@/lib/metrics';
import { periodFamily, rangeFromParams, todayInTimezone } from '@/lib/dates';
import type { ScorecardResult } from '@/lib/metrics/service';
import type { ScorecardView, ScorecardStat, CampaignPick } from '@/lib/scorecard/assemble';
import type { DataMaturity } from '@/lib/metrics/maturity';

const ACCENT: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  initial_cash: 'success',
  enrollments: 'accent',
  paid_cac: 'warning',
  blended_cac: 'info',
  roas: 'success',
  ltv_cac: 'accent',
  applied: 'info',
  consults_booked: 'accent',
  consult_show_rate: 'accent',
  roadmaps_booked: 'accent',
  roadmap_show_rate: 'accent',
  spend: 'warning',
  cpl: 'info',
  cost_consult: 'accent',
  cost_roadmap: 'info',
  cost_client: 'warning',
};

const StatTile: React.FC<{ stat: ScorecardStat; comparisonLabel: string | null; maturity: DataMaturity }> = ({ stat, comparisonLabel, maturity }) => (
  <KpiDeltaTile
    label={stat.label}
    value={stat.value}
    delta={stat.delta}
    deltaKind={stat.deltaKind}
    comparisonLabel={comparisonLabel}
    accent={ACCENT[stat.key] ?? 'accent'}
    subtext={stat.sub}
    empty={stat.empty}
    ring={stat.deltaKind === 'pct' && !stat.empty ? stat.delta.current : undefined}
    trendMetric={stat.key}
    maturity={maturity}
    maturing={stat.maturing}
  />
);

const CampaignCard: React.FC<{ pick: CampaignPick | null; kind: 'top' | 'worst'; note: string }> = ({ pick, kind, note }) => {
  const Icon = kind === 'top' ? Trophy : Frown;
  const good = kind === 'top';
  return (
    <div className="surface-raised rounded-[12px] p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-[22px] w-[22px] grid place-items-center rounded-[6px]" style={{ background: good ? 'var(--positive-muted)' : 'var(--negative-muted)', color: good ? 'var(--positive-text)' : 'var(--negative-text)' }}>
          <Icon size={12.5} strokeWidth={2.3} />
        </div>
        <span className="text-[11.5px] font-medium uppercase tracking-[0.045em]" style={{ color: 'var(--text-tertiary)' }}>
          {kind === 'top' ? 'Best campaign by cost per client' : 'Worst campaign by cost per client'}
        </span>
      </div>
      {pick ? (
        <>
          <div className="text-[15px] font-semibold leading-tight truncate" style={{ color: 'var(--text-primary)' }} title={pick.campaignName}>
            {pick.campaignName}
          </div>
          <div className="flex items-baseline gap-2 mt-1.5">
            <span className="text-[22px] font-semibold tabular tracking-[-0.02em]" style={{ color: good ? 'var(--positive-text)' : 'var(--negative-text)' }}>
              {formatCents(pick.costPerEnrollmentCents)}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              per client · {pick.enrolled} enrolled from {formatCents(pick.spendCents, { compact: true })} · {pick.platform}
            </span>
          </div>
        </>
      ) : (
        <div className="rounded-[8px] px-3 py-2.5 text-[12px]" style={{ background: 'var(--surface-sunken)', border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)' }}>
          {note || 'Nothing to rank.'}
        </div>
      )}
    </div>
  );
};

function ScorecardPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [data, setData] = useState<{ result: ScorecardResult; view: ScorecardView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Default to the completed week — the same period the Monday email covers.
  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of ['range', 'start', 'end', 'compare']) {
      const v = params.get(key);
      if (v) q.set(key, v);
    }
    if (!q.get('range')) q.set('range', 'last_week');
    return q.toString();
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/scorecard/view?${query}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
        return body as { result: ScorecardResult; view: ScorecardView };
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const timezone = data?.result.timezone ?? 'America/New_York';
  const today = todayInTimezone(timezone);
  const range = rangeFromParams({ range: params.get('range') ?? 'last_week', start: params.get('start'), end: params.get('end') }, today);
  const family = periodFamily(range);

  const setKind = useCallback(
    (kind: 'weekly' | 'monthly') => {
      const q = new URLSearchParams(params.toString());
      q.set('range', kind === 'weekly' ? 'last_week' : 'last_month');
      q.delete('start');
      q.delete('end');
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const toggle = (
    <div className="inline-flex items-center rounded-[8px] p-0.5" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }} role="tablist" aria-label="Scorecard grain">
      {(['weekly', 'monthly'] as const).map((k) => {
        const active = (k === 'weekly' && family === 'week') || (k === 'monthly' && family === 'month');
        const Icon = k === 'weekly' ? CalendarRange : CalendarDays;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setKind(k)}
            className="focus-ring inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[6px] text-[12px] font-medium transition-colors"
            style={{ background: active ? 'var(--surface)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-tertiary)', boxShadow: active ? 'var(--shadow-sm)' : undefined }}
          >
            <Icon size={12.5} strokeWidth={2.3} />
            {k === 'weekly' ? 'Weekly' : 'Monthly'}
          </button>
        );
      })}
    </div>
  );

  const header = (
    <PageHeader
      title={data ? data.view.title : 'Scorecard'}
      description="How did the week (or month) go? Money → Pipeline → Ads, every number vs the period before. This is the same scorecard the Monday email renders."
      actions={toggle}
    >
      <DateRangePicker timezone={timezone} />
    </PageHeader>
  );

  if (loading && !data) {
    return (
      <>
        {header}
        <PageBody className="space-y-5" aria-busy="true">
          {[6, 5, 5].map((n, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3">
              {Array.from({ length: n }).map((_, j) => (
                <SkeletonTile key={j} />
              ))}
            </div>
          ))}
          <Skeleton className="h-[90px]" />
        </PageBody>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {header}
        <PageBody>
          <EmptyState title="Could not load the scorecard" description={error ?? 'Unknown error'} />
        </PageBody>
      </>
    );
  }

  const { view, result } = data;
  const cmpLabel = view.comparison ? `${view.period.label} vs ${view.comparison.label}` : null;
  const section = (title: string, icon: React.ComponentType<{ size?: number; strokeWidth?: number }>, stats: ScorecardStat[], cols: string, extra?: React.ReactNode) => {
    const Icon = icon;
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 grid place-items-center rounded-[6px]" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
            <Icon size={13.5} strokeWidth={2.2} />
          </div>
          <h2 className="text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
          {cmpLabel && (
            <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              · {cmpLabel}
            </span>
          )}
        </div>
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${cols} gap-3 stagger`}>
          {stats.map((st) => (
            <StatTile key={st.key} stat={st} comparisonLabel={cmpLabel} maturity={view.maturity} />
          ))}
          {extra}
        </div>
      </section>
    );
  };

  return (
    <>
      {header}
      <PageBody className="space-y-6">
        <SampleDataBanner page="numbers" />

        {family === null && (
          <div className="px-3.5 py-2.5 rounded-[10px] text-[12.5px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}>
            The scorecard is built for whole weeks and months — pick Weekly or Monthly above to use the ◀ ▶ cycler. Showing {view.period.label}.
          </div>
        )}

        {view.empty && (
          <Card padding="lg">
            <EmptyState compact title={`Nothing happened in ${view.title.toLowerCase()}`} description="No applications, bookings or enrollments were observed. The email for this period would be skipped." />
          </Card>
        )}

        {section('Money', Banknote, view.sections.money, 'xl:grid-cols-6')}
        {section('Pipeline', Filter, view.sections.pipeline, 'xl:grid-cols-5')}
        {section('Ads', Megaphone, view.sections.ads, 'xl:grid-cols-5')}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <CampaignCard pick={view.campaigns.top} kind="top" note={view.campaigns.note} />
          <CampaignCard pick={view.campaigns.worst} kind="worst" note={view.campaigns.top && !view.campaigns.worst ? view.campaigns.note : view.campaigns.note} />
        </div>

        <FunnelStrip
          funnel={result.scorecard.cohort.funnel}
          conversions={result.scorecard.cohort.conversions}
          href={`/funnel?${query}&mode=cohort`}
          rangeLabel={`${view.title} · who applied then, and where they are now`}
          title="Cohort funnel"
          maturity={view.maturity}
        />

        <Card padding="lg">
          <CardHeader
            title={view.narrativeTitle}
            subtitle={view.narrative ? 'Generated by the nightly job from this same scorecard' : 'No narrative stored for this period yet'}
            icon={Sparkles}
            action={
              <Link href="/reports" className="text-[12px] font-medium inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                Email archive <ArrowRight size={12} />
              </Link>
            }
          />
          {view.narrative ? (
            <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
              {view.narrative}
            </p>
          ) : (
            <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
              The Monday / 1st-of-month dispatch writes one paragraph per period into ai_reports once Anthropic is connected. Until then the numbers above are the scorecard.
            </p>
          )}
        </Card>

        {view.notes.length > 0 && (
          <ul className="space-y-1.5">
            {view.notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]" style={{ color: n.tone === 'warn' ? 'var(--warning)' : 'var(--text-tertiary)' }}>
                <Badge variant={n.tone === 'warn' ? 'warning' : 'neutral'} size="xs">
                  {n.tone === 'warn' ? 'check' : 'note'}
                </Badge>
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        )}
      </PageBody>

      <Toast isVisible={Boolean(error)} message="Could not refresh the scorecard" detail={error ?? undefined} type="error" onClose={() => undefined} />
    </>
  );
}

export default function ScorecardRoute() {
  return (
    <Suspense
      fallback={
        <PageBody className="space-y-5" aria-busy="true">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonTile key={i} />
            ))}
          </div>
        </PageBody>
      }
    >
      <ScorecardPage />
    </Suspense>
  );
}
