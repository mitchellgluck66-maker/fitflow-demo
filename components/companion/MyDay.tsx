'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Button, Skeleton } from '@/components';
import { FetchError } from '@/components/FetchError';
import { fetchJson } from '@/lib/clientFetch';
import { addDays, formatDayLabel } from '@/lib/day';
import type { MyDay as MyDayData } from '@/lib/companion/service';
import { CallTypeTag, SourceLine, StatusChip, timeRange } from './calls';
import { PopOutButton } from './PopOutButton';

/** The Companion's home: the viewed user's calls for one local day (item 2). */
export const MyDay: React.FC = () => {
  const router = useRouter();
  const params = useSearchParams();
  const date = params.get('date');
  const user = params.get('user');
  const [day, setDay] = useState<MyDayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // The effect only subscribes to the fetch; state moves in its callbacks (never synchronously in the effect body).
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (user) q.set('user', user);
    fetchJson<MyDayData>(`/api/companion/day?${q.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setDay(d);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        // A disabled login: the API says so; send them to sign in again.
        if (e instanceof Error && 'status' in e && (e as { status: number | null }).status === 401) router.replace('/login?next=/companion');
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, user, tick, router]);

  const load = useCallback(() => {
    setRefreshing(true);
    setTick((t) => t + 1);
  }, []);
  const loading = day === null && error === null;

  const go = (next: { date?: string | null; user?: string | null }) => {
    const q = new URLSearchParams();
    const d = next.date === undefined ? date : next.date;
    const u = next.user === undefined ? user : next.user;
    if (d) q.set('date', d);
    if (u) q.set('user', u);
    router.replace(q.toString() ? `/companion?${q}` : '/companion');
  };

  const shown = day?.date ?? date ?? null;
  const isToday = day ? day.date === day.today : false;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
            My day{day && !day.viewing.isSelf ? <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}> · viewing as {day.viewing.name}</span> : day ? <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}> · {day.viewing.name}</span> : null}
          </h1>
          <p className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {day ? `${day.counts.calls} call${day.counts.calls === 1 ? '' : 's'} · ${day.counts.logged} logged · ${day.counts.needOutcome} need${day.counts.needOutcome === 1 ? 's' : ''} an outcome${day.counts.failed ? ` · ${day.counts.failed} failed` : ''}` : '…'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {day && day.technicians.length > 1 && (
            <select aria-label="Whose day" value={day.viewing.id} onChange={(e) => go({ user: e.target.value })} className="h-8 px-2 text-[12.5px] rounded-[7px]" style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}>
              {day.technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <PopOutButton date={shown} user={user} />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-[8px]" style={{ border: '1px solid var(--border-default)', background: 'var(--surface)' }}>
          <button type="button" aria-label="Previous day" className="h-8 w-8 grid place-items-center focus-ring rounded-l-[8px] hover:bg-[var(--surface-hover)]" style={{ color: 'var(--text-secondary)' }} disabled={!shown} onClick={() => shown && go({ date: addDays(shown, -1) })}>
            <ChevronLeft size={15} />
          </button>
          <input
            type="date"
            aria-label="Date"
            value={shown ?? ''}
            max={day?.today}
            onChange={(e) => go({ date: e.target.value || null })}
            className="h-8 px-2 text-[12.5px] bg-transparent focus-ring"
            style={{ color: 'var(--text-primary)' }}
          />
          <button type="button" aria-label="Next day" className="h-8 w-8 grid place-items-center focus-ring rounded-r-[8px] hover:bg-[var(--surface-hover)] disabled:opacity-40" style={{ color: 'var(--text-secondary)' }} disabled={!shown || isToday} onClick={() => shown && go({ date: addDays(shown, 1) })}>
            <ChevronRight size={15} />
          </button>
        </div>
        {!isToday && (
          <Button size="sm" variant="ghost" onClick={() => go({ date: null })}>
            Today
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={load} loading={refreshing}>
          Refresh
        </Button>
        {day && (
          <span className="text-[12.5px] ml-auto" style={{ color: 'var(--text-secondary)' }}>
            {formatDayLabel(day.date, day.timezone)}
          </span>
        )}
      </div>

      {day && <SourceLine source={day.source} fetchedAt={day.fetchedAt} asOf={day.asOf} reason={day.reason} timezone={day.timezone} onRetry={load} />}

      {error && !day && <FetchError title="Could not load your day" error={error} onRetry={load} />}
      {error && day && <FetchError compact title="Could not refresh" error={error} onRetry={load} />}

      {loading && !day && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[72px] rounded-[12px]" />
          ))}
        </div>
      )}

      {day && day.source === 'none' && (
        <div className="surface-raised rounded-[12px] p-5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {day.reason}
        </div>
      )}

      {day && day.source !== 'none' && day.calls.length === 0 && (
        <div className="surface-raised rounded-[12px] p-5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          No calls on {formatDayLabel(day.date, day.timezone)}.
        </div>
      )}

      {day && day.calls.length > 0 && (
        <ol className="space-y-2" aria-label="Calls">
          {day.calls.map((c) => (
            <li key={c.eventId} className="surface-raised rounded-[12px] px-4 py-3" style={{ opacity: c.outcomeInGhl === 'cancelled' ? 0.6 : 1 }}>
              <div className="flex items-start gap-3">
                <div className="w-[88px] shrink-0">
                  <div className="text-[13.5px] font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
                    {timeRange(c, day.timezone).split(' – ')[0]}
                  </div>
                  <div className="text-[11px] tabular" style={{ color: 'var(--text-quaternary)' }}>
                    {c.endIso ? `to ${timeRange(c, day.timezone).split(' – ')[1]}` : ''}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[14px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {c.name}
                    </span>
                    <StatusChip status={c.status} outcomeInGhl={c.outcomeInGhl} action={c.action} />
                  </div>
                  <div className="mt-0.5">
                    <CallTypeTag callType={c.callType} calendarName={c.calendarName} />
                  </div>
                  <div className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    {c.stage ? (
                      <>
                        {c.stage.name}
                        {c.stage.pipeline && <span style={{ color: 'var(--text-quaternary)' }}> · {c.stage.pipeline}</span>}
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-quaternary)' }}>not in a tracked pipeline yet</span>
                    )}
                  </div>
                </div>
                <Link href={`/companion/popout?date=${day.date}&event=${encodeURIComponent(c.eventId)}${user ? `&user=${encodeURIComponent(user)}` : ''}`} className="text-[12px] underline underline-offset-2 shrink-0 focus-ring rounded" style={{ color: 'var(--text-tertiary)' }}>
                  Brief
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
