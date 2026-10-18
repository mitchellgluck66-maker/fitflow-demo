'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search, X, Mail, Phone } from 'lucide-react';
import { fetchJson } from '@/lib/clientFetch';
import { formatDayLabel, formatTime } from '@/lib/day';
import { selectCurrent, endOf, type CompanionCall } from '@/lib/companion/day';
import type { MyDay } from '@/lib/companion/service';
import type { ClientBrief, SearchRow } from '@/lib/companion/brief';
import { CallTypeTag, DryRunBanner, SourceLine, StatusChip } from './calls';
import { LogPanel, type LogPanelPreview } from './LogPanel';

const DAY_REFRESH_MS = 60_000;
const ADVANCE_TICK_MS = 30_000;

interface Me {
  preferences: { autoAdvance: boolean };
  timezone: string | null;
}

/**
 * The brief (item 3): auto-selects the current call, ◀ ▶ through the day, search (mirror + live GHL), the client
 * brief with the last 3 notes, and the disabled outcome area ("Logging arrives in stage 2"). Sized for a
 * 360×520 always-on-top window; `?float=0` means the browser could not float it.
 */
export const PopOut: React.FC = () => {
  const params = useSearchParams();
  const date = params.get('date');
  const user = params.get('user');
  const eventParam = params.get('event');
  const cannotFloat = params.get('float') === '0';
  /** Screenshots only: a canned log-panel state served by /api/companion/preview (404 outside COMPANION_PREVIEW=1). */
  const previewParam = params.get('preview');
  const [preview, setPreview] = useState<LogPanelPreview | null>(null);
  const [dryRun, setDryRun] = useState(false);

  const [day, setDay] = useState<MyDay | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [tick, setTick] = useState(0);
  /** The clock the auto-selection reads; advanced every 30 s while auto-advance is on (and on every day load). */
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** A call chosen with ◀ ▶ (or named in the URL) stays selected until it ends. */
  const [pin, setPin] = useState<{ eventId: string } | null>(() => (eventParam ? { eventId: eventParam } : null));
  const [picked, setPicked] = useState<{ ghlContactId: string; eventId: string | null } | null>(null);
  const [brief, setBrief] = useState<{ key: string; data: ClientBrief } | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ results: SearchRow[]; liveError: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The day (re-read every minute; the server caches live reads for two) and the viewer's preferences.
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (date) qs.set('date', date);
    if (user) qs.set('user', user);
    fetchJson<MyDay>(`/api/companion/day?${qs}`)
      .then((d) => {
        if (cancelled) return;
        setDay(d);
        setDayError(null);
        setNowMs(Date.now());
      })
      .catch((e) => {
        if (!cancelled) setDayError(e instanceof Error ? e.message : String(e));
      });
    fetchJson<Me>('/api/companion/me')
      .then((m) => !cancelled && setMe(m))
      .catch(() => undefined);
    const t = setTimeout(() => setTick((x) => x + 1), DAY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [date, user, tick]);

  useEffect(() => {
    if (!previewParam) return;
    let cancelled = false;
    fetchJson<LogPanelPreview>(`/api/companion/preview?state=${encodeURIComponent(previewParam)}`)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setDryRun(p.outcomes.dryRun.on);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [previewParam]);

  // The clock ticks only while auto-advance is on; with it off the selection made at load stays.
  const autoAdvance = me?.preferences.autoAdvance ?? true;
  useEffect(() => {
    if (!autoAdvance) return;
    const t = setInterval(() => setNowMs(Date.now()), ADVANCE_TICK_MS);
    return () => clearInterval(t);
  }, [autoAdvance]);

  // Selection, derived: the pinned call while it has not ended (always, when auto-advance is off), else the clock.
  const calls = useMemo(() => day?.calls ?? [], [day]);
  const index = useMemo(() => {
    if (calls.length === 0) return null;
    const pinIndex = pin ? calls.findIndex((c) => c.eventId === pin.eventId) : -1;
    if (pinIndex >= 0 && (!autoAdvance || nowMs < endOf(calls[pinIndex]))) return pinIndex;
    const i = selectCurrent(calls, new Date(nowMs));
    return i >= 0 ? i : null;
  }, [calls, pin, autoAdvance, nowMs]);

  const current: CompanionCall | null = index !== null && calls[index] ? calls[index] : null;
  const target = useMemo(() => picked ?? (current ? { ghlContactId: current.ghlContactId, eventId: current.eventId } : null), [picked, current]);
  const targetKey = target ? `${target.ghlContactId}|${target.eventId ?? ''}` : null;
  const shownBrief = brief && brief.key === targetKey ? brief.data : null;
  const briefLoading = Boolean(target) && !shownBrief && !briefError;

  // The brief for the selected call or the picked search result (state moves only in the callbacks).
  useEffect(() => {
    if (!target || !targetKey) return;
    let cancelled = false;
    const qs = new URLSearchParams({ contact: target.ghlContactId });
    if (target.eventId) qs.set('event', target.eventId);
    if (date) qs.set('date', date);
    if (user) qs.set('user', user);
    fetchJson<ClientBrief>(`/api/companion/brief?${qs}`)
      .then((b) => {
        if (cancelled) return;
        setBrief({ key: targetKey, data: b });
        setBriefError(null);
      })
      .catch((e) => !cancelled && setBriefError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [target, targetKey, date, user]);

  const step = (d: -1 | 1) => {
    if (calls.length === 0) return;
    const base = index ?? (d === 1 ? -1 : calls.length);
    const next = Math.min(calls.length - 1, Math.max(0, base + d));
    setPicked(null);
    setPin({ eventId: calls[next].eventId });
  };

  const onSearch = (value: string) => {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      fetchJson<{ results: SearchRow[]; liveError: string | null }>(`/api/companion/search?q=${encodeURIComponent(value.trim())}`)
        .then(setResults)
        .catch((e) => setResults({ results: [], liveError: e instanceof Error ? e.message : String(e) }))
        .finally(() => setSearching(false));
    }, 300);
  };

  const tz = day?.timezone ?? me?.timezone ?? 'UTC';
  const position = index !== null && calls.length ? `${index + 1} of ${calls.length}` : calls.length ? `${calls.length} today` : '';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-canvas)', color: 'var(--text-primary)', fontSize: 13 }}>
      {cannotFloat && (
        <div role="status" className="px-3 py-1.5 text-[11.5px]" style={{ background: 'var(--warning-muted)', borderBottom: '1px solid var(--warning-border)' }}>
          This browser can&apos;t float the brief over other windows. Use Chrome 116+ for an always-on-top window.
        </div>
      )}

      {/* Header: ◀ current call ▶ */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-overlay)' }}>
        <button type="button" aria-label="Previous call" onClick={() => step(-1)} disabled={calls.length === 0 || index === 0} className="h-7 w-7 grid place-items-center rounded-[6px] hover:bg-[var(--surface-hover)] disabled:opacity-30 focus-ring" style={{ color: 'var(--text-secondary)' }}>
          <ChevronLeft size={15} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-[11px] truncate" style={{ color: 'var(--text-quaternary)' }}>
            {day ? `${formatDayLabel(day.date, tz).replace(/, \d{4}$/, '')}${position ? ` · ${position}` : ''}` : '…'}
          </div>
          {current && !picked ? (
            <div className="text-[12px] font-medium truncate tabular">
              {formatTime(current.startIso, tz)} · {current.callType === 'Other' ? current.calendarName : current.callType}
            </div>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              {picked ? 'From search' : calls.length ? 'No call selected' : day ? `No calls on ${formatDayLabel(day.date, tz).split(',')[0]}` : ''}
            </div>
          )}
        </div>
        <button type="button" aria-label="Next call" onClick={() => step(1)} disabled={calls.length === 0 || index === calls.length - 1} className="h-7 w-7 grid place-items-center rounded-[6px] hover:bg-[var(--surface-hover)] disabled:opacity-30 focus-ring" style={{ color: 'var(--text-secondary)' }}>
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pt-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-quaternary)' }} />
          <input
            type="search"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search a name or email"
            aria-label="Search contacts"
            className="w-full h-8 pl-8 pr-7 text-[12.5px] rounded-[8px] focus-ring"
            style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          />
          {(q || picked) && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQ('');
                setResults(null);
                setPicked(null);
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 grid place-items-center rounded"
              style={{ color: 'var(--text-quaternary)' }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {results && (
          <ul className="mt-1 rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-raised)' }} aria-label="Search results">
            {results.results.length === 0 && !searching && (
              <li className="px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                No one matches “{q}”.
              </li>
            )}
            {results.results.slice(0, 8).map((r) => (
              <li key={r.ghlContactId}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked({ ghlContactId: r.ghlContactId, eventId: null });
                    setResults(null);
                  }}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-[var(--surface-hover)] focus-ring"
                >
                  <span className="text-[12.5px] font-medium">{r.name}</span>
                  <span className="text-[11px] ml-1.5" style={{ color: 'var(--text-quaternary)' }}>
                    {r.email ?? r.phone ?? ''}
                    {r.source === 'live' ? ' · GHL' : ''}
                  </span>
                </button>
              </li>
            ))}
            {results.liveError && (
              <li className="px-2.5 py-1 text-[11px]" style={{ color: 'var(--warning)', borderTop: '1px solid var(--border-subtle)' }}>
                GoHighLevel search unavailable: {results.liveError}
              </li>
            )}
          </ul>
        )}
      </div>

      {dryRun && (
        <div className="px-2.5 pt-2">
          <DryRunBanner compact />
        </div>
      )}
      {day && day.source !== 'live' && (
        <div className="px-2.5 pt-2">
          <SourceLine compact source={day.source} fetchedAt={day.fetchedAt} asOf={day.asOf} reason={day.reason} timezone={tz} onRetry={() => setTick((x) => x + 1)} />
        </div>
      )}
      {dayError && (
        <p className="px-2.5 pt-2 text-[11.5px]" style={{ color: 'var(--negative-text, var(--danger))' }}>
          {dayError}
        </p>
      )}

      {/* Brief */}
      <div className="flex-1 px-2.5 py-2 space-y-2.5 overflow-y-auto" data-testid="companion-brief">
        {!target && !dayError && day && (
          <p className="text-[12.5px] pt-6 text-center" style={{ color: 'var(--text-tertiary)' }}>
            {calls.length ? 'Pick a call with the arrows or search for someone.' : 'Search for someone to see their brief.'}
          </p>
        )}
        {briefLoading && (
          <p className="text-[12px]" style={{ color: 'var(--text-quaternary)' }}>
            Loading the brief…
          </p>
        )}
        {briefError && <p className="text-[12px]" style={{ color: 'var(--negative-text, var(--danger))' }}>{briefError}</p>}
        {shownBrief && (
          <>
            <div>
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-[17px] font-semibold tracking-[-0.01em] leading-tight">
                  {shownBrief.contact.name}
                </h1>
                {current && !picked && <StatusChip status={current.status} outcomeInGhl={current.outcomeInGhl} />}
              </div>
              {shownBrief.call && (
                <div className="mt-0.5">
                  <CallTypeTag callType={shownBrief.call.callType} calendarName={shownBrief.call.calendarName} />
                  <span className="text-[11.5px] ml-1.5 tabular" style={{ color: 'var(--text-quaternary)' }}>
                    {formatTime(shownBrief.call.startIso, tz)}
                    {shownBrief.call.endIso ? ` – ${formatTime(shownBrief.call.endIso, tz)}` : ''}
                  </span>
                </div>
              )}
              <div className="mt-1.5 space-y-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <div className="flex items-center gap-1.5">
                  <Mail size={12} style={{ color: 'var(--text-quaternary)' }} />
                  {shownBrief.contact.email ? (
                    <a href={`mailto:${shownBrief.contact.email}`} className="truncate underline-offset-2 hover:underline">
                      {shownBrief.contact.email}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text-quaternary)' }}>no email</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Phone size={12} style={{ color: 'var(--text-quaternary)' }} />
                  {shownBrief.contact.phone ? <span className="tabular">{shownBrief.contact.phone}</span> : <span style={{ color: 'var(--text-quaternary)' }}>no phone</span>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-[8px] px-2.5 py-2" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
                <div className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                  Days in pipeline
                </div>
                {shownBrief.daysInPipeline ? (
                  <>
                    <div className="text-[16px] font-semibold tabular">{shownBrief.daysInPipeline.days}</div>
                    <div className="text-[10.5px]" style={{ color: 'var(--text-quaternary)' }}>
                      since {shownBrief.daysInPipeline.since}
                    </div>
                  </>
                ) : (
                  <div className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                    {shownBrief.contact.inMirror ? 'no application date' : 'not in the mirror yet'}
                  </div>
                )}
              </div>
              <div className="rounded-[8px] px-2.5 py-2 min-w-0" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
                <div className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                  Stage
                </div>
                {shownBrief.stage ? (
                  <>
                    <div className="text-[12.5px] font-medium leading-snug">{shownBrief.stage.name}</div>
                    {shownBrief.stage.pipeline && (
                      <div className="text-[10.5px] truncate" style={{ color: 'var(--text-quaternary)' }}>
                        {shownBrief.stage.pipeline}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                    {shownBrief.contact.inMirror ? 'not in a tracked pipeline' : 'not in the mirror yet'}
                  </div>
                )}
              </div>
            </div>

            <section aria-label="Notes">
              <div className="text-[10.5px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-quaternary)' }}>
                Last notes {shownBrief.notes.status === 'ok' && shownBrief.notes.total > 0 ? `(${Math.min(3, shownBrief.notes.total)} of ${shownBrief.notes.total})` : ''}
              </div>
              {shownBrief.notes.status === 'unavailable' ? (
                <p className="text-[11.5px] rounded-[8px] px-2.5 py-1.5" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}>
                  Notes unavailable: {shownBrief.notes.reason}
                </p>
              ) : shownBrief.notes.items.length === 0 ? (
                <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                  No notes in GoHighLevel yet.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {shownBrief.notes.items.map((n) => (
                    <li key={n.id} className="rounded-[8px] px-2.5 py-1.5 text-[12px] leading-snug" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
                      <div className="whitespace-pre-wrap break-words">{n.body}</div>
                      <div className="text-[10.5px] mt-0.5 tabular" style={{ color: 'var(--text-quaternary)' }}>
                        {n.dateAdded ? new Date(n.dateAdded).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                        {n.author ? ` · ${n.author}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <LogPanel
              key={targetKey ?? 'none'}
              ghlContactId={shownBrief.contact.ghlContactId}
              call={current && !picked ? current : null}
              timezone={tz}
              existingActionId={current && !picked ? (current.action?.id ?? null) : null}
              onChanged={() => setTick((x) => x + 1)}
              onDryRun={setDryRun}
              preview={preview}
            />
          </>
        )}
      </div>
    </div>
  );
};
