'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Users, Search, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, PageHeader, PageBody, PageLoader, SampleDataBanner, EmptyState, Badge, Button, Input, Select } from '@/components';
import type { ClientListResult } from '@/lib/queries/clients';

const PAGE = 50;

function roleVariant(role: string | null): 'success' | 'danger' | 'neutral' | 'accent' {
  if (role === 'enrolled') return 'success';
  if (role === 'consult_noshow') return 'danger';
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
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const filters = useMemo(
    () => ({
      q: params.get('q') ?? '',
      stage: params.get('stage') ?? '',
      source: params.get('source') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      page: Math.max(Number(params.get('page') ?? 1), 1),
    }),
    [params],
  );

  const [q, setQ] = useState(filters.q);
  const [data, setData] = useState<ClientListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setFilter = useCallback(
    (patch: Record<string, string | number | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '' || v === 0) next.delete(k);
        else next.set(k, String(v));
      }
      if (!('page' in patch)) next.delete('page');
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  // Debounce the search box into the URL.
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => setFilter({ q }), 250);
    return () => clearTimeout(t);
  }, [q, filters.q, setFilter]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams();
    if (filters.q) query.set('q', filters.q);
    if (filters.stage) query.set('stage', filters.stage);
    if (filters.source) query.set('source', filters.source);
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    query.set('limit', String(PAGE));
    query.set('offset', String((filters.page - 1) * PAGE));
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
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const clear = () => {
    setQ('');
    router.replace(pathname);
  };

  const hasFilters = Boolean(filters.q || filters.stage || filters.source || filters.from || filters.to);
  const total = data?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE), 1);

  return (
    <>
      <PageHeader title="Clients" description="Everyone observed in the pipeline. Read-only — the record of truth stays in GoHighLevel." />

      <PageBody className="space-y-4">
        <SampleDataBanner page="clients" />

        <Card padding="sm">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-60">
              <Input icon={Search} placeholder="Name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="w-full sm:w-48">
              <Select value={filters.stage} onChange={(e) => setFilter({ stage: e.target.value })}>
                <option value="">All stages</option>
                {data?.facets.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.count})
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-44">
              <Select value={filters.source} onChange={(e) => setFilter({ source: e.target.value })}>
                <option value="">All sources</option>
                {data?.facets.sources.map((s) => (
                  <option key={s.source} value={s.source === 'Unknown' ? '' : s.source}>
                    {s.source} ({s.count})
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-40">
              <Input label="Applied from" type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
            </div>
            <div className="w-full sm:w-40">
              <Input label="to" type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
            </div>
            {hasFilters && (
              <Button variant="ghost" icon={X} onClick={clear}>
                Clear
              </Button>
            )}
            <div className="flex-1" />
            <span className="text-[12px] tabular pb-2" style={{ color: 'var(--text-tertiary)' }}>
              {total.toLocaleString()} {total === 1 ? 'person' : 'people'}
            </span>
          </div>
        </Card>

        {loading && !data ? (
          <PageLoader label="Loading clients" />
        ) : error ? (
          <Card>
            <EmptyState title="Could not load clients" description={error} />
          </Card>
        ) : !data || data.rows.length === 0 ? (
          <Card>
            <EmptyState icon={<Users size={18} />} title="No one matches" description={hasFilters ? 'Try widening the filters.' : 'Run a GoHighLevel sync to populate this list.'} />
          </Card>
        ) : (
          <Card padding="sm" className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ background: 'var(--surface-sunken)' }}>
                  {['Name', 'Stage', 'Source', 'Applied', 'Last activity', 'Owner'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2">
                      <Link href={`/clients/${r.id}`} className="font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>
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

            {pages > 1 && (
              <div className="flex items-center justify-between px-3 pt-3">
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Page {filters.page} of {pages}
                </span>
                <div className="flex gap-1.5">
                  <Button variant="ghost" icon={ChevronLeft} disabled={filters.page <= 1} onClick={() => setFilter({ page: filters.page - 1 })}>
                    Prev
                  </Button>
                  <Button variant="ghost" iconRight={ChevronRight} disabled={filters.page >= pages} onClick={() => setFilter({ page: filters.page + 1 })}>
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
