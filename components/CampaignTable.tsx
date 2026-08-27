'use client';

import React, { useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { Badge } from './Badge';
import { EmptyState } from './PageHeader';
import { PeopleDrawer } from './PeopleDrawer';
import { computeDelta, formatCents, formatDelta, type CampaignRow, type Delta, type FunnelStageKey } from '@/lib/metrics';

const TRACKED: Array<{ key: FunnelStageKey; label: string; unit: string }> = [
  { key: 'applied', label: 'Applied', unit: 'lead' },
  { key: 'consult_booked', label: 'Consults', unit: 'consult' },
  { key: 'enrolled', label: 'Enrolled', unit: 'client' },
];

const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap';
const num = 'px-3 py-2.5 text-right tabular';

const DeltaChip: React.FC<{ delta: Delta; kind?: 'count' | 'cents'; label: string | null }> = ({ delta, kind = 'count', label }) => {
  if (delta.direction === 'none' || delta.direction === 'flat') return null;
  const color = delta.good === null ? 'var(--text-tertiary)' : delta.good ? 'var(--success)' : 'var(--danger)';
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
 * priced per stage. Manual weekly spend shows as its own row per platform.
 */
export const CampaignTable: React.FC<{
  campaigns: CampaignRow[];
  previous: CampaignRow[] | null;
  comparisonLabel: string | null;
}> = ({ campaigns, previous, comparisonLabel }) => {
  const [drawer, setDrawer] = useState<{ title: string; subtitle: string; ids: string[] } | null>(null);
  const prevByKey = new Map((previous ?? []).map((c) => [c.key, c]));

  if (campaigns.length === 0) {
    return <EmptyState title="No spend in this period" description="Enter weekly spend below or connect Meta Ads in Setup." />;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              <th className={th} style={{ color: 'var(--text-quaternary)' }} rowSpan={2}>
                Campaign
              </th>
              <th className={`${th} text-center`} colSpan={4} style={{ color: 'var(--text-tertiary)', borderLeft: '1px solid var(--border-subtle)' }}>
                Platform-reported
              </th>
              <th className={`${th} text-center`} colSpan={3} style={{ color: 'var(--accent)', borderLeft: '1px solid var(--border-subtle)' }}>
                FitFlow-tracked
              </th>
            </tr>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              {['Spend', 'Impr.', 'Clicks', 'Leads'].map((h, i) => (
                <th key={h} className={`${th} text-right`} style={{ color: 'var(--text-quaternary)', borderLeft: i === 0 ? '1px solid var(--border-subtle)' : undefined }}>
                  {h}
                </th>
              ))}
              {TRACKED.map((t, i) => (
                <th key={t.key} className={`${th} text-right`} style={{ color: 'var(--text-quaternary)', borderLeft: i === 0 ? '1px solid var(--border-subtle)' : undefined }}>
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
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
                  <td className={num} style={{ color: 'var(--text-secondary)' }}>
                    {c.from === 'api' ? c.impressions.toLocaleString() : '—'}
                  </td>
                  <td className={num} style={{ color: 'var(--text-secondary)' }}>
                    {c.from === 'api' ? c.clicks.toLocaleString() : '—'}
                  </td>
                  <td className={num} style={{ color: 'var(--text-secondary)' }}>
                    {c.from === 'api' ? c.platformLeads.toLocaleString() : '—'}
                  </td>
                  {TRACKED.map((t, i) => {
                    const count = c.tracked[t.key];
                    const cost = c.costPer[t.key];
                    return (
                      <td key={t.key} className={num} style={{ borderLeft: i === 0 ? '1px solid var(--border-subtle)' : undefined }}>
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
                                setDrawer({ title: `${c.campaignName} · ${t.label}`, subtitle: `${count} ${count === 1 ? 'person' : 'people'} tracked to this campaign`, ids: c.contactIds[t.key] })
                              }
                              className="font-semibold tabular rounded-[4px] px-1 -mx-1 transition-colors disabled:cursor-default enabled:hover:bg-[var(--surface-hover)]"
                              style={{ color: count > 0 ? 'var(--accent)' : 'var(--text-quaternary)' }}
                            >
                              {count}
                            </button>
                            {t.key === 'enrolled' && <DeltaChip delta={enrolledDelta} label={comparisonLabel} />}
                            <div className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                              {cost !== null ? `${formatCents(cost)}/${t.unit}` : '—'}
                            </div>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PeopleDrawer open={drawer !== null} onClose={() => setDrawer(null)} title={drawer?.title ?? ''} subtitle={drawer?.subtitle} contactIds={drawer?.ids ?? []} />
    </>
  );
};
