'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Download, RefreshCw, Headset, AlertTriangle, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, EmptyState, KPITile, PageBody, PageHeader, SampleDataBanner, SkeletonTable, SkeletonTile, Toast } from '@/components';
import { FetchError } from '@/components/FetchError';
import { fetchJson } from '@/lib/clientFetch';
import { addDays, weekStart } from '@/lib/dates';
import { formatTime } from '@/lib/day';
import type { OnboardingView } from '@/lib/onboarding/service';
import { FILTERS, filterCounts, ghlResultOf, matchesFilter, outcomeLabelOf, stageMoveOf, type OnboardingCall, type OnboardingFilter } from '@/lib/onboarding/numbers';

const TONE_VARIANT: Record<ReturnType<typeof outcomeLabelOf>['tone'], 'success' | 'info' | 'neutral' | 'warning' | 'accent' | 'danger'> = { good: 'success', blue: 'info', gray: 'neutral', amber: 'warning', purple: 'accent', red: 'danger' };
const RESULT_COLOR: Record<ReturnType<typeof ghlResultOf>['tone'], string> = { ok: 'var(--positive)', warn: 'var(--warning)', bad: 'var(--danger)', neutral: 'var(--text-tertiary)' };

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
const loggedAt = (iso: string, tz: string) => formatTime(iso, tz);

/** Jake's Onboarding page (stage 3, item 1): every companion user's calls for a day or a Sun–Sat week. */
export const OnboardingPage: React.FC = () => {
  const router = useRouter();
  const params = useSearchParams();
  const date = params.get('date');
  const range = params.get('range') === 'week' ? 'week' : 'day';
  const [view, setView] = useState<OnboardingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<OnboardingFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ range });
    if (date) q.set('date', date);
    fetchJson<OnboardingView>(`/api/onboarding?${q.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setView(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, range, tick]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setTick((t) => t + 1);
  }, []);

  const go = (next: { date?: string; range?: 'day' | 'week' }) => {
    const q = new URLSearchParams();
    const r = next.range ?? range;
    const d = next.date ?? view?.date ?? date;
    q.set('range', r);
    if (d) q.set('date', d);
    router.push(`/onboarding?${q.toString()}`);
  };

  const step = (dir: -1 | 1) => {
    const base = view?.date ?? date ?? view?.today;
    if (!base) return;
    go({ date: range === 'week' ? addDays(weekStart(base), dir * 7) : addDays(base, dir) });
  };
  const canForward = view ? (range === 'week' ? weekStart(view.date) < weekStart(view.today) : view.date < view.today) : false;

  const retry = async (c: OnboardingCall) => {
    if (!c.log) return;
    setBusy(c.log.id);
    try {
      const r = await fetch(`/api/companion/actions/${c.log.id}/retry`, { method: 'POST' });
      const d = (await r.json().catch(() => ({}))) as { error?: string; action?: { state: string } };
      if (r.ok) setToast({ message: d.action?.state === 'ok' ? `Retried — ${c.name} is updated in GoHighLevel` : `Retried — still ${d.action?.state ?? 'failing'}`, type: d.action?.state === 'ok' ? 'success' : 'error' });
      else setToast({ message: 'Retry failed', detail: d.error, type: 'error' });
      reload();
    } finally {
      setBusy(null);
    }
  };

  const calls = useMemo(() => view?.calls ?? [], [view]);
  const counts = useMemo(() => filterCounts(calls), [calls]);
  const shown = useMemo(() => calls.filter((c) => matchesFilter(c, filter)), [calls, filter]);
  const n = view?.numbers;
  const tz = view?.timezone ?? 'UTC';
  const loading = view === null && error === null;
  const mirrorUsers = view?.users.filter((u) => u.source === 'mirror' && u.reason) ?? [];
  const csvHref = `/api/onboarding?${new URLSearchParams({ range, ...(view?.date ? { date: view.date } : {}), format: 'csv' }).toString()}`;

  return (
    <>
      <PageHeader
        title="Onboarding"
        description="Every consult and roadmap call, the outcome Miranda logged, and what changed in GoHighLevel."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Range" className="flex p-[3px] rounded-[10px]" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)' }}>
              {(['day', 'week'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => go({ range: r })}
                  className="text-[13px] font-semibold px-3.5 h-8 rounded-[7px] transition-colors"
                  style={range === r ? { background: 'var(--accent)', color: '#fff' } : { color: 'var(--text-secondary)' }}
                >
                  {r === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>
            <Button icon={ChevronLeft} aria-label={range === 'week' ? 'Previous week' : 'Previous day'} onClick={() => step(-1)} disabled={!view} />
            <span className="text-[14px] font-semibold tabular px-1" style={{ color: 'var(--text-primary)' }}>
              {view?.label ?? '…'}
            </span>
            <Button icon={ChevronRight} aria-label={range === 'week' ? 'Next week' : 'Next day'} onClick={() => step(1)} disabled={!canForward} />
            <a href={csvHref} download className="inline-flex">
              <Button icon={Download} disabled={!view || calls.length === 0}>
                Export CSV
              </Button>
            </a>
            <Button icon={RefreshCw} loading={refreshing} onClick={reload}>
              Refresh
            </Button>
          </div>
        }
      />
      <PageBody className="space-y-4">
        <SampleDataBanner page="onboarding calls" />

        {error && !view && <FetchError title="Could not load the onboarding calls" error={error} onRetry={reload} />}

        {loading && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {Array.from({ length: 6 }, (_, i) => (
                <SkeletonTile key={i} />
              ))}
            </div>
            <Card padding="lg">
              <SkeletonTable rows={6} cols={6} />
            </Card>
          </>
        )}

        {view && n && (
          <>
            {view.reason && (
              <Card padding="lg">
                <EmptyState icon={<Headset size={18} />} title="No onboarding login yet" description={view.reason} action={<Link href="/setup#users"><Button variant="primary">Open Setup → Users</Button></Link>} />
              </Card>
            )}

            {!view.reason && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                  <KPITile label="Calls" value={n.calls} subtext={`${n.consults} consult${n.consults === 1 ? '' : 's'} · ${n.roadmaps} roadmap${n.roadmaps === 1 ? '' : 's'}${n.other ? ` · ${n.other} other` : ''}`} />
                  <KPITile label="Logged" value={`${n.logged} of ${n.calls}`} subtext={n.needsOutcome ? `${n.needsOutcome} need${n.needsOutcome === 1 ? 's' : ''} an outcome` : n.unlogged ? `${n.unlogged} unlogged` : 'every ended call logged'} accent={n.needsOutcome ? 'warning' : 'accent'} />
                  <KPITile label="Showed" value={n.showed} subtext={n.logged ? `of ${n.logged} logged · ${pct(n.showedPct)}` : 'nothing logged yet'} />
                  <KPITile label="Roadmaps booked" value={n.roadmapsBooked} subtext={`from ${n.consults} consult${n.consults === 1 ? '' : 's'}`} accent="info" />
                  <KPITile label="Enrolled" value={n.enrolled} subtext={`from ${n.roadmaps} roadmap${n.roadmaps === 1 ? '' : 's'}`} accent="success" />
                  <KPITile label="No-shows" value={n.noShows} subtext={`${n.consultNoShows} consult · ${n.roadmapNoShows} roadmap`} accent={n.noShows ? 'warning' : 'accent'} />
                </div>

                {mirrorUsers.length > 0 && (
                  <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] px-3 py-2 text-[12.5px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--text-primary)' }}>
                    <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                    {mirrorUsers.map((u) => (
                      <span key={u.userId}>
                        {u.name}: showing synced data{u.asOf ? ` from ${new Date(u.asOf).toLocaleString()}` : ''} — GoHighLevel could not be read ({u.reason}).
                      </span>
                    ))}
                  </div>
                )}

                {view.attention.length > 0 && (
                  <div role="status" data-testid="attention-bar" className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[12px] px-4 py-3 text-[13.5px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--text-primary)' }}>
                    <strong className="font-bold">
                      {view.attention.length} need{view.attention.length === 1 ? 's' : ''} attention
                    </strong>
                    {view.attention.map((a) => (
                      <span key={`${a.kind}:${a.eventId}`}>{a.text}</span>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
                  {FILTERS.map((f) => {
                    const on = filter === f.key;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setFilter(f.key)}
                        className="text-[13px] font-semibold h-9 px-3.5 rounded-full transition-colors"
                        style={on ? { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' } : { background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                      >
                        {f.label} · {counts[f.key]}
                      </button>
                    );
                  })}
                </div>

                <Card padding="none">
                  {calls.length === 0 ? (
                    <EmptyState icon={<Headset size={18} />} title={`No onboarding calls ${range === 'week' ? 'this week' : 'on this day'}`} description={view.users.every((u) => u.source === 'mirror') ? `Nothing assigned to ${view.users.map((u) => u.name).join(', ')} in the synced calendars for ${view.label}.` : `Nothing assigned to ${view.users.map((u) => u.name).join(', ')} on ${view.label}.`} />
                  ) : shown.length === 0 ? (
                    <EmptyState compact title="No calls match this filter" description="Pick another filter above." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13.5px]" style={{ minWidth: 1080 }}>
                        <thead>
                          <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)', background: 'var(--surface-sunken)' }}>
                            <th className="px-4 py-3">{range === 'week' ? 'When' : 'Time'}</th>
                            <th className="px-4 py-3">Client</th>
                            <th className="px-4 py-3">Outcome</th>
                            <th className="px-4 py-3">Stage before → after</th>
                            <th className="px-4 py-3">Note</th>
                            <th className="px-4 py-3">GoHighLevel</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((c) => {
                            const o = outcomeLabelOf(c);
                            const g = ghlResultOf(c);
                            const bad = c.status === 'needs_outcome';
                            const warn = g.tone === 'warn';
                            return (
                              <tr key={c.eventId} data-testid={`call-${c.eventId}`} className="align-top" style={{ borderTop: '1px solid var(--border-subtle)', background: bad ? 'var(--danger-muted)' : warn ? 'var(--warning-muted)' : undefined }}>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                                    {range === 'week' ? `${c.date.slice(5).replace('-', '/')} ${c.timeLabel}` : c.timeLabel}
                                  </div>
                                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                    {c.callType === 'Other' ? c.calendarName : c.callType}
                                    {view.users.length > 1 ? ` · ${c.userName}` : ''}
                                  </div>
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {c.contactId ? (
                                    <Link href={`/clients/${c.contactId}`} className="font-semibold hover:underline" style={{ color: 'var(--accent)' }}>
                                      {c.name}
                                    </Link>
                                  ) : (
                                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                                  )}
                                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                    {c.log ? `Logged ${loggedAt(c.log.createdAt, tz)} by ${c.log.userName}` : c.undone ? `Undone${c.undone.undoneBy ? ` by ${c.undone.undoneBy}` : ''}` : bad ? 'No log yet' : ''}
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <Badge variant={TONE_VARIANT[o.tone]} size="xs">
                                    {o.label}
                                  </Badge>
                                </td>
                                <td className="px-4 py-3 text-[13px]" style={{ color: 'var(--text-secondary)', minWidth: 200 }}>
                                  {stageMoveOf(c)}
                                </td>
                                <td className="px-4 py-3 text-[13px] leading-snug" style={{ color: 'var(--text-secondary)', maxWidth: 340 }}>
                                  {c.log?.note ?? '—'}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <div className="font-semibold text-[13px]" style={{ color: RESULT_COLOR[g.tone] }}>
                                    {g.label}
                                  </div>
                                  {g.sub && (
                                    <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                      {g.sub}
                                    </div>
                                  )}
                                  {g.canRetry && c.log && (
                                    <Button size="xs" variant="secondary" icon={RotateCcw} className="mt-2" loading={busy === c.log.id} disabled={busy !== null} onClick={() => retry(c)}>
                                      Retry {c.log.failedStep ?? 'log'}
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
                  Times in {view.timezone}. Every log keeps who, when, the stage before and after, and GoHighLevel&apos;s reply; nothing is ever deleted. Undone logs stay listed, marked &quot;Undone&quot;.
                  {view.users.some((u) => u.source === 'live') ? ' Today is live from GoHighLevel (refreshed every 2 minutes).' : ''}
                </p>
              </>
            )}
          </>
        )}
      </PageBody>
      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </>
  );
};
