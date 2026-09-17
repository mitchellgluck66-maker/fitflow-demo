'use client';

import React, { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { Badge } from './Badge';
import { EmptyState } from './PageHeader';
import { PeopleDrawer } from './PeopleDrawer';
import { FilterBar, NoMatches } from './FilterBar';
import { SortableHeader } from './SortableHeader';
import { useTableState, applyClient, facetOptions } from './useTableState';
import { computeDelta, formatCents, formatDelta, type CampaignRow, type Delta, type FunnelStageKey } from '@/lib/metrics';
import { DEFAULT_DISPLAYED_METRICS } from '@/lib/metrics/display';

/** Platform-reported columns, keyed by displayed-metric key. */
const PLATFORM_COLS: Array<{ key: string; label: string; sortKey: string; value: (c: CampaignRow) => number | null; format: (v: number) => string }> = [
  { key: 'impressions', label: 'Impr.', sortKey: 'impressions', value: (c) => c.impressions, format: (v) => v.toLocaleString() },
  { key: 'reach', label: 'Reach', sortKey: 'reach', value: (c) => c.reach, format: (v) => v.toLocaleString() },
  { key: 'frequency', label: 'Freq.', sortKey: 'frequency', value: (c) => c.frequency, format: (v) => v.toFixed(2) },
  { key: 'cpm', label: 'CPM', sortKey: 'cpm', value: (c) => c.cpmCents, format: (v) => formatCents(v) },
  { key: 'link_clicks', label: 'Link clicks', sortKey: 'link_clicks', value: (c) => c.linkClicks, format: (v) => v.toLocaleString() },
  { key: 'clicks', label: 'Clicks', sortKey: 'clicks', value: (c) => c.clicks, format: (v) => v.toLocaleString() },
  { key: 'cpc', label: 'CPC', sortKey: 'cpc', value: (c) => c.cpcCents, format: (v) => formatCents(v) },
  { key: 'landing_page_views', label: 'LPV', sortKey: 'lpv', value: (c) => c.landingPageViews, format: (v) => v.toLocaleString() },
  { key: 'platform_leads', label: 'Leads', sortKey: 'leads', value: (c) => c.platformLeads, format: (v) => v.toLocaleString() },
  { key: 'purchases', label: 'Purch.', sortKey: 'purchases', value: (c) => c.purchases, format: (v) => v.toLocaleString() },
];

const TRACKED: Array<{ key: string; stage: FunnelStageKey; label: string; unit: string }> = [
  { key: 'tracked_applied', stage: 'applied', label: 'Applied', unit: 'lead' },
  { key: 'tracked_consults', stage: 'consult_booked', label: 'Consults', unit: 'consult' },
  { key: 'tracked_roadmaps', stage: 'roadmap_booked', label: 'Roadmaps', unit: 'roadmap' },
  { key: 'tracked_enrolled', stage: 'enrolled', label: 'Enrolled', unit: 'client' },
];

const FACETS = ['platform', 'from', 'campaign'];

const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap';
const num = 'px-3 py-2.5 text-right tabular';

const DeltaChip: React.FC<{ delta: Delta; kind?: 'count' | 'cents'; label: string | null }> = ({ delta, kind = 'count', label }) => {
  if (delta.direction === 'none' || delta.direction === 'flat') return null;
  const color = delta.good === null ? 'var(--text-tertiary)' : delta.good ? 'var(--positive-text)' : 'var(--negative-text)';
  const Icon = delta.direction === 'up' ? TrendingUp : TrendingDown;
  return (
    <span
      className="inline-flex items-center gap-0.5 ml-1.5 px-1 h-[16px] rounded-[4px] text-[10.5px] font-semibold tabular cursor-help"
      style={{ color, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
      title={label ? `${formatDelta(delta, kind)} · ${label}` : formatDelta(delta, kind)}
    >
      <Icon size={10} strokeWidth={2.4} />
      {delta.pct !== null ? `${Math.abs(delta.pct * 100).toFixed(0)}%` : formatDelta(delta, kind)}
    </span>
  );
};

/**
 * Hyros-style campaign table: platform-reported numbers on the left,
 * FitFlow-tracked funnel counts (joined by utm_campaign) on the right, each
 * priced per stage, plus per-campaign ROAS from initial cash. Manual weekly
 * spend shows as its own row per platform. Which columns render is the
 * CEO's choice (`displayed` — settings.displayed_metrics); everything is
 * computed regardless. Filter/sort/search state lives in the URL under the
 * `c_` prefix.
 */
export const CampaignTable: React.FC<{
  campaigns: CampaignRow[];
  previous: CampaignRow[] | null;
  comparisonLabel: string | null;
  displayed?: Set<string>;
  awaitingStripe?: boolean;
}> = ({ campaigns, previous, comparisonLabel, displayed, awaitingStripe }) => {
  const shown = displayed ?? new Set(DEFAULT_DISPLAYED_METRICS);
  const [drawer, setDrawer] = useState<{ title: string; subtitle: string; ids: string[] } | null>(null);
  const prevByKey = useMemo(() => new Map((previous ?? []).map((c) => [c.key, c])), [previous]);
  const t = useTableState({ prefix: 'c_', facetKeys: FACETS });

  const platformCols = PLATFORM_COLS.filter((c) => shown.has(c.key));
  const trackedCols = TRACKED.filter((c) => shown.has(c.key));
  const showRoas = shown.has('tracked_roas');

  const rows = useMemo(
    () =>
      applyClient(campaigns, t.state, {
        search: [(c) => c.campaignName, (c) => c.platform, (c) => c.campaignId],
        facets: {
          platform: (c) => c.platform,
          from: (c) => c.from,
          campaign: (c) => c.campaignName,
        },
        sorts: {
          campaign: (c) => c.campaignName,
          spend: (c) => c.spendCents,
          ...Object.fromEntries(PLATFORM_COLS.map((col) => [col.sortKey, (c: CampaignRow) => (c.from === 'api' ? col.value(c) : null)])),
          ...Object.fromEntries(TRACKED.map((col) => [col.stage, (c: CampaignRow) => (c.from === 'api' ? c.tracked[col.stage] : null)])),
          roas: (c) => c.roas,
        },
        defaultSort: { key: 'spend', dir: 'desc' },
      }),
    [campaigns, t.state],
  );

  if (campaigns.length === 0) {
    return <EmptyState title="No spend in this period" description="Enter weekly spend below or connect Meta Ads in Setup." />;
  }

  const activeSort = t.state.sort ?? 'spend';
  const dir = t.state.sort ? t.state.dir : 'desc';
  const hs = { color: 'var(--text-quaternary)' };
  const trackedSpan = trackedCols.length + (showRoas ? 1 : 0);

  return (
    <div className="space-y-3">
      <FilterBar
        state={t.state}
        facets={[
          { key: 'platform', label: 'Platform', options: facetOptions(campaigns, (c) => c.platform) },
          { key: 'from', label: 'Source of truth', options: facetOptions(campaigns, (c) => c.from, (v) => (v === 'api' ? 'Platform API' : 'Manual')) },
          { key: 'campaign', label: 'Campaign', options: facetOptions(campaigns, (c) => c.campaignName).slice(0, 12) },
        ]}
        onQ={t.setQ}
        onToggle={t.toggleFilter}
        onClear={t.clearFilters}
        shown={rows.length}
        total={campaigns.length}
        placeholder="Search campaigns…"
        noun="campaigns"
      />

      {rows.length === 0 ? (
        <NoMatches onClear={t.clearFilters} noun="campaigns" />
      ) : (
        <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                <SortableHeader label="Campaign" sortKey="campaign" activeKey={activeSort} dir={dir} onSort={t.setSort} rowSpan={2} style={hs} />
                <th className={`${th} text-center`} colSpan={1 + platformCols.length} style={{ color: 'var(--text-tertiary)', borderLeft: '1px solid var(--border-subtle)' }}>
                  Platform-reported
                </th>
                {trackedSpan > 0 && (
                  <th className={`${th} text-center`} colSpan={trackedSpan} style={{ color: 'var(--accent)', borderLeft: '1px solid var(--border-subtle)' }}>
                    FitFlow-tracked
                  </th>
                )}
              </tr>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                <SortableHeader label="Spend" sortKey="spend" activeKey={activeSort} dir={dir} onSort={t.setSort} align="right" style={{ ...hs, borderLeft: '1px solid var(--border-subtle)' }} />
                {platformCols.map((col) => (
                  <SortableHeader key={col.key} label={col.label} sortKey={col.sortKey} activeKey={activeSort} dir={dir} onSort={t.setSort} align="right" style={hs} />
                ))}
                {trackedCols.map((tr, i) => (
                  <SortableHeader key={tr.key} label={tr.label} sortKey={tr.stage} activeKey={activeSort} dir={dir} onSort={t.setSort} align="right" style={{ ...hs, borderLeft: i === 0 ? '1px solid var(--border-subtle)' : undefined }} />
                ))}
                {showRoas && (
                  <SortableHeader label="ROAS" sortKey="roas" activeKey={activeSort} dir={dir} onSort={t.setSort} align="right" style={{ ...hs, borderLeft: trackedCols.length === 0 ? '1px solid var(--border-subtle)' : undefined }} />
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const prev = prevByKey.get(c.key);
                const spendDelta = computeDelta(c.spendCents, prev?.spendCents ?? null, true);
                const enrolledDelta = computeDelta(c.tracked.enrolled, prev?.tracked.enrolled ?? null);
                return (
                  <tr key={c.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {c.campaignName}
                        </span>
                        <Badge variant="neutral" size="xs">
                          {c.platform}
                        </Badge>
                        <Badge variant={c.from === 'api' ? 'info' : 'warning'} size="xs">
                          {c.from === 'api' ? `from ${c.platform === 'meta' ? 'Meta' : c.platform}` : 'manual'}
                        </Badge>
                      </div>
                    </td>
                    <td className={num} style={{ color: 'var(--text-primary)', borderLeft: '1px solid var(--border-subtle)' }}>
                      <span className="font-semibold">{formatCents(c.spendCents)}</span>
                      <DeltaChip delta={spendDelta} kind="cents" label={comparisonLabel} />
                    </td>
                    {platformCols.map((col) => {
                      const v = c.from === 'api' ? col.value(c) : null;
                      return (
                        <td key={col.key} className={num} style={{ color: 'var(--text-secondary)' }}>
                          {v === null ? '—' : col.format(v)}
                        </td>
                      );
                    })}
                    {trackedCols.map((tr, i) => {
                      const count = c.tracked[tr.stage];
                      const cost = c.costPer[tr.stage];
                      return (
                        <td key={tr.key} className={num} style={{ borderLeft: i === 0 ? '1px solid var(--border-subtle)' : undefined }}>
                          {c.from === 'manual' ? (
                            <span title="Manual spend has no campaign to attribute contacts to" style={{ color: 'var(--text-quaternary)' }}>
                              —
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={count === 0}
                                onClick={() =>
                                  setDrawer({ title: `${c.campaignName} · ${tr.label}`, subtitle: `${count} ${count === 1 ? 'person' : 'people'} tracked to this campaign`, ids: c.contactIds[tr.stage] })
                                }
                                className="font-semibold tabular rounded-[4px] px-1 -mx-1 transition-colors disabled:cursor-default enabled:hover:bg-[var(--surface-hover)] focus-ring"
                                style={{ color: count > 0 ? (tr.stage === 'enrolled' ? 'var(--positive-text, var(--accent))' : 'var(--accent)') : 'var(--text-quaternary)' }}
                              >
                                {count}
                              </button>
                              {tr.stage === 'enrolled' && <DeltaChip delta={enrolledDelta} label={comparisonLabel} />}
                              <div className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                                {cost !== null ? `${formatCents(cost)}/${tr.unit}` : '—'}
                              </div>
                            </>
                          )}
                        </td>
                      );
                    })}
                    {showRoas && (
                      <td className={num} style={{ borderLeft: trackedCols.length === 0 ? '1px solid var(--border-subtle)' : undefined }}>
                        {c.from === 'manual' ? (
                          <span style={{ color: 'var(--text-quaternary)' }}>—</span>
                        ) : awaitingStripe ? (
                          <span title="Connect Stripe for ROAS" style={{ color: 'var(--text-quaternary)' }}>
                            awaiting Stripe
                          </span>
                        ) : (
                          <>
                            <span className="font-semibold" style={{ color: c.roas !== null && c.roas >= 1 ? 'var(--positive-text, var(--success))' : 'var(--text-primary)' }}>
                              {c.roas !== null ? `${c.roas.toFixed(2)}×` : '—'}
                            </span>
                            <div className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                              {formatCents(c.initialCents, { compact: true })} initial
                            </div>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PeopleDrawer open={drawer !== null} onClose={() => setDrawer(null)} title={drawer?.title ?? ''} subtitle={drawer?.subtitle} contactIds={drawer?.ids ?? []} />
    </div>
  );
};
