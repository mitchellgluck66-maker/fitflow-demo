'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Badge, Button, Input } from '@/components';
import { FilterBar, NoMatches } from '@/components/FilterBar';
import { SortableHeader } from '@/components/SortableHeader';
import { useTableState } from '@/components/useTableState';
import { SkeletonTable } from '@/components/Skeleton';
import type { ClientListResult } from '@/lib/queries/clients';

const PAGE = 50;
const FACETS = ['stage', 'source', 'status', 'appt', 'attribution', 'from', 'to'];

function roleVariant(role: string | null): 'positive' | 'negative' | 'neutral' | 'accent' {
  if (role === 'enrolled') return 'positive';
  if (role === 'consult_noshow') return 'negative';
  if (role === 'consult_booked' || role === 'roadmap_booked' || role === 'roadmap_showed') return 'accent';
  return 'neutral';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

function ClientsIndex() {
  const t = useTableState({ facetKeys: FACETS });
  const { state } = t;
  const [data, setData] = useState<ClientListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loading is derived: the key of the last fulfilled request vs the current one.
  const [fetchedKey, setFetchedKey] = useState<string | null>(null);

  // Applied-date bounds ride along as single-value "facets".
  const from = state.filters.from?.[0] ?? '';
  const to = state.filters.to?.[0] ?? '';
  const requestKey = JSON.stringify([state, from, to]);
  const loading = fetchedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams();
    if (state.q) query.set('q', state.q);
    for (const key of ['stage', 'source', 'status', 'appt', 'attribution'] as const) {
      const v = state.filters[key];
      if (v?.length) query.set(key, v.join(','));
    }
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (state.sort) {
      query.set('sort', state.sort);
      query.set('dir', state.dir);
    }
    query.set('limit', String(PAGE));
    query.set('offset', String((state.page - 1) * PAGE));
    fetch(`/api/clients?${query.toString()}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
        return body as ClientListResult;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setFetchedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [state, from, to, requestKey]);

  const total = data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE), 1);
  const activeSort = state.sort ?? 'applied';
  const dir = state.sort ? state.dir : 'desc';
  const th = { color: 'var(--text-quaternary)' };
  const hasFilters = Boolean(state.q || Object.keys(state.filters).length);

  return (
    <>
      <PageHeader title="Clients" description="Everyone observed in the pipeline. Read-only — the record of truth stays in GoHighLevel." />

      <PageBody className="space-y-4">
        <SampleDataBanner page="clients" />

        <Card padding="sm">
          <FilterBar
            state={state}
            facets={[
              { key: 'stage', label: 'Stage', options: (data?.facets.stages ?? []).filter((s) => s.count > 0).map((s) => ({ value: s.id, label: s.name, count: s.count })) },
              { key: 'source', label: 'Source', options: (data?.facets.sources ?? []).map((s) => ({ value: s.source, label: s.source, count: s.count })) },
              { key: 'status', label: 'Status', options: (data?.facets.statuses ?? []).map((s) => ({ value: s.status, label: s.status, count: s.count })) },
              { key: 'appt', label: 'Appointment', options: (data?.facets.apptTypes ?? []).map((a) => ({ value: a.type, label: a.type, count: a.count })) },
              { key: 'attribution', label: 'Attribution', options: (data?.facets.attribution ?? []).filter((a) => a.attribution !== 'unclassified').map((a) => ({ value: a.attribution, label: a.attribution, count: a.count })) },
            ]}
            onQ={t.setQ}
            onToggle={t.toggleFilter}
            onClear={t.clearFilters}
            shown={data?.rows.length ?? 0}
            total={total}
            placeholder="Name, email or phone…"
            noun="people"
            extra={
              <div className="flex items-center gap-1.5">
                <div className="w-36">
                  <Input type="date" aria-label="Applied from" value={from} onChange={(e) => t.setFilter('from', e.target.value ? [e.target.value] : [])} />
                </div>
                <span className="text-[12px]" style={{ color: 'var(--text-quaternary)' }}>
                  to
                </span>
                <div className="w-36">
                  <Input type="date" aria-label="Applied to" value={to} onChange={(e) => t.setFilter('to', e.target.value ? [e.target.value] : [])} />
                </div>
              </div>
            }
          />
        </Card>

        {loading && !data ? (
          <Card padding="sm">
            <SkeletonTable rows={8} cols={6} />
          </Card>
        ) : error ? (
          <Card>
            <EmptyState title="Could not load clients" description={error} />
          </Card>
        ) : !data || data.rows.length === 0 ? (
          <Card>
            {hasFilters ? (
              <NoMatches onClear={t.clearFilters} noun="people" />
            ) : (
              <EmptyState icon={<Users size={18} />} title="No one yet" description="Run a GoHighLevel sync to populate this list." />
            )}
          </Card>
        ) : (
          <Card padding="sm" className="overflow-x-auto">
            <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 150ms' }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ background: 'var(--surface-sunken)' }}>
                  <SortableHeader label="Name" sortKey="name" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                  <SortableHeader label="Stage" sortKey="stage" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                  <SortableHeader label="Source" sortKey="source" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                  <SortableHeader label="Applied" sortKey="applied" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                  <SortableHeader label="Last activity" sortKey="activity" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={th}>
                    Owner
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="row-clickable" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2">
                      <Link href={`/clients/${r.id}`} className="font-medium hover:underline focus-ring rounded" style={{ color: 'var(--text-primary)' }}>
                        {r.name}
                      </Link>
                      <div className="text-[11.5px] truncate max-w-[260px]" style={{ color: 'var(--text-tertiary)' }}>
                        {r.email ?? r.phone ?? ''}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.stageName ? (
                        <Badge variant={roleVariant(r.stageRole)} size="xs">
                          {r.stageName}
                        </Badge>
                      ) : (
                        <span style={{ color: 'var(--text-quaternary)' }}>—</span>
                      )}
                    </td>
                    <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                      {r.source ?? '—'}
                      {r.attributionClass && (
                        <Badge variant={r.attributionClass === 'paid' ? 'accent' : 'neutral'} size="xs" className="ml-1.5">
                          {r.attributionClass}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                      {fmtDate(r.appliedAt)}
                    </td>
                    <td className="px-3 py-2 tabular whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                      {fmtDate(r.lastActivityAt)}
                    </td>
                    <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>
                      {r.owner ?? '—'}
                      {r.origin === 'demo' && (
                        <Badge variant="warning" size="xs" className="ml-1.5">
                          sample
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between px-3 pt-3">
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Page {state.page} of {pages}
                </span>
                <div className="flex gap-1.5">
                  <Button variant="ghost" icon={ChevronLeft} disabled={state.page <= 1} onClick={() => t.setPage(state.page - 1)}>
                    Prev
                  </Button>
                  <Button variant="ghost" iconRight={ChevronRight} disabled={state.page >= pages} onClick={() => t.setPage(state.page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  );
}

export default function ClientsPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading clients" />}>
      <ClientsIndex />
    </Suspense>
  );
}
