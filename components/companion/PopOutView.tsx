'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fetchJson } from '@/lib/clientFetch';
import { formatTime } from '@/lib/day';
import { selectCurrent, endOf, type CompanionCall } from '@/lib/companion/day';
import type { MyDay } from '@/lib/companion/service';
import type { ClientBrief, SearchRow } from '@/lib/companion/brief';
import type { PopOutHostKind } from '@/lib/companion/popout';
import { collapseReducer, COLLAPSED_EVENT, dayTitle, moveDelta, nextCallLabel, readCollapsed, statusChip, writeCollapsed, type PopOutProblem, type ScreenPos } from '@/lib/companion/popoutState';
import { BriefBlock, CollapsedBar, LastNote, LogFooter, NoteField, OutcomeGrid, PopOutHeader, ResultSteps, SettingsPopover } from './PopOutParts';
import { useOutcomeLog, type PopOutPreview } from './useOutcomeLog';

const DAY_REFRESH_MS = 60_000;
const ADVANCE_TICK_MS = 30_000;
const MAX_WINDOW_PROBLEMS = 5;

interface Me {
  user: { hasRow: boolean };
  preferences: { autoAdvance: boolean };
  timezone: string | null;
}

/**
 * Where the pop-out page runs. `resize` changes the window / panel for a collapsed state and resolves the measured
 * top-left corner before and after (null when there is nothing to measure — a plain tab); it THROWS when the resize
 * is refused, and the view turns that into the status chip + console.error.
 */
export interface PopOutHost {
  kind: PopOutHostKind;
  resize?: (collapsed: boolean) => Promise<{ before: ScreenPos; after: ScreenPos } | null>;
  dragHandle?: React.HTMLAttributes<HTMLDivElement>;
  onClose?: () => void;
}

export const TAB_HOST: PopOutHost = { kind: 'tab' };

const subscribeCollapsed = (cb: () => void) => {
  window.addEventListener(COLLAPSED_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(COLLAPSED_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
};
/** The saved collapsed state as an external store: the server renders expanded, the client re-reads storage after hydration (no mismatch). */
const useCollapsedState = () => useSyncExternalStore(subscribeCollapsed, () => readCollapsed(window.localStorage), () => false);

/** A message the opener posts into the pop-out (theme sync failures): `{ type: 'companion-popout:problem', detail }`. */
export const POPOUT_PROBLEM_MESSAGE = 'companion-popout:problem';

/**
 * The pop-out (stage 4): header 48 px with ONE status chip, the brief, the 2×3 outcome grid, the note, the last note
 * and a fixed "Log outcome" footer — 360×560, never scrolls. Collapsed = the header row as a bar. Auto-selects the
 * current call, ◀ ▶ through the day, search through the gear. The write path is stage 2's, untouched.
 */
export const PopOutView: React.FC<{ date: string | null; user: string | null; event: string | null; host: PopOutHost; previewState: string | null }> = ({ date, user, event: eventParam, host, previewState }) => {
  const [preview, setPreview] = useState<PopOutPreview | null>(null);
  const [day, setDay] = useState<MyDay | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [tick, setTick] = useState(0);
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
  const collapsed = useCollapsedState();
  const [windowProblems, setWindowProblems] = useState<PopOutProblem[]>([]);
  const [prefError, setPrefError] = useState<string | null>(null);

  const addWindowProblem = useCallback((detail: string) => {
    console.error(`[companion pop-out] ${detail}`);
    setWindowProblems((list) => (list.some((p) => p.detail === detail) ? list : [{ kind: 'window' as const, detail }, ...list].slice(0, MAX_WINDOW_PROBLEMS)));
  }, []);

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
      .catch((e) => !cancelled && setDayError(e instanceof Error ? e.message : String(e)));
    fetchJson<Me>('/api/companion/me')
      .then((m) => !cancelled && setMe(m))
      .catch(() => undefined);
    const t = setTimeout(() => setTick((x) => x + 1), DAY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [date, user, tick]);

  // Screenshots only: a canned state served by /api/companion/preview (404 outside COMPANION_PREVIEW=1).
  useEffect(() => {
    if (!previewState) return;
    let cancelled = false;
    fetchJson<PopOutPreview>(`/api/companion/preview?state=${encodeURIComponent(previewState)}`)
      .then((p) => !cancelled && setPreview(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [previewState]);

  // The opener reports a failed theme sync here — never swallowed.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; detail?: string } | null;
      if (data && data.type === POPOUT_PROBLEM_MESSAGE && typeof data.detail === 'string') addWindowProblem(data.detail);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addWindowProblem]);

  // The clock ticks only while auto-advance is on; with it off the selection made at load stays.
  const autoAdvance = me?.preferences.autoAdvance ?? true;
  useEffect(() => {
    if (!autoAdvance) return;
    const t = setInterval(() => setNowMs(Date.now()), ADVANCE_TICK_MS);
    return () => clearInterval(t);
  }, [autoAdvance]);

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

  const onChanged = useCallback(() => setTick((x) => x + 1), []);
  const call = current && !picked ? current : null;
  const log = useOutcomeLog({ targetKey, ghlContactId: target?.ghlContactId ?? null, call, existingActionId: call?.action?.id ?? null, onChanged, preview });

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

  const setAutoAdvance = async (v: boolean) => {
    try {
      const r = await fetch('/api/companion/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoAdvance: v }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!r.ok) throw new Error(d.detail ? `${d.error ?? 'Could not save'} — ${d.detail}` : (d.error ?? `HTTP ${r.status}`));
      setMe((m) => (m ? { ...m, preferences: { ...m.preferences, autoAdvance: v } } : m));
      setPrefError(null);
    } catch (e) {
      setPrefError(`Auto-advance could not be saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ONLY the button toggles (collapseReducer ignores every other event); the state is saved; the host resizes.
  const toggleCollapsed = async () => {
    const next = collapseReducer(collapsed, { type: 'toggle_button' });
    if (!writeCollapsed(window.localStorage, next)) addWindowProblem('The collapsed state could not be saved (browser storage unavailable) — it will not survive a reopen');
    window.dispatchEvent(new Event(COLLAPSED_EVENT));
    if (!host.resize) return;
    try {
      const m = await host.resize(next);
      if (!m) return;
      const d = moveDelta(m.before, m.after);
      if (process.env.NODE_ENV !== 'production') console.log(`[companion pop-out] toggle → ${next ? 'collapsed' : 'expanded'} · before (${m.before.x}, ${m.before.y}) · after (${m.after.x}, ${m.after.y}) · ${d.held ? 'held' : `MOVED ${d.dx}, ${d.dy}`}`);
      if (!d.held) addWindowProblem(`The window moved ${d.dx} × ${d.dy} px on ${next ? 'collapse' : 'expand'} (from ${m.before.x}, ${m.before.y} to ${m.after.x}, ${m.after.y})`);
    } catch (e) {
      addWindowProblem(`Resize to ${next ? 'the bar' : 'full size'} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const tz = day?.timezone ?? me?.timezone ?? 'UTC';
  const problems = useMemo<PopOutProblem[]>(() => {
    const list: PopOutProblem[] = [...(preview?.problems ?? [])];
    if (dayError) list.push({ kind: 'app', detail: `Could not load the day: ${dayError}` });
    if (day && day.source === 'mirror') list.push({ kind: 'ghl', detail: `GoHighLevel could not be reached${day.reason ? `: ${day.reason}` : ''} — showing synced data from ${day.asOf ? formatTime(day.asOf, tz) : 'the last sync'}` });
    if (day && day.source === 'none' && day.reason) list.push({ kind: 'app', detail: day.reason });
    if (briefError) list.push({ kind: 'app', detail: `Could not load the brief: ${briefError}` });
    if (shownBrief?.notes.status === 'unavailable') list.push({ kind: 'ghl', detail: `Notes unavailable: ${shownBrief.notes.reason}` });
    if (results?.liveError) list.push({ kind: 'ghl', detail: `GoHighLevel search unavailable: ${results.liveError}` });
    if (prefError) list.push({ kind: 'app', detail: prefError });
    list.push(...log.problems, ...windowProblems);
    if (log.dryRun) list.push({ kind: 'dry_run', detail: 'Outcomes are logged here, nothing is sent to GoHighLevel. The owner turns this off in Setup → Companion.' });
    return list;
  }, [preview, dayError, day, tz, briefError, shownBrief, results, prefError, log.problems, log.dryRun, windowProblems]);
  const chip = useMemo(() => statusChip(problems), [problems]);

  const title = day ? `${dayTitle(day.date, day.today)}${index !== null && calls.length ? ` · ${index + 1} of ${calls.length}` : calls.length ? ` · ${calls.length} calls` : ' · no calls'}` : '…';
  const settings = <SettingsPopover host={host.kind} autoAdvance={me ? me.preferences.autoAdvance : null} hasRow={me?.user.hasRow ?? false} onAutoAdvance={setAutoAdvance} search={{ q, onChange: onSearch, results, searching, onPick: (r) => { setPicked({ ghlContactId: r.ghlContactId, eventId: null }); setResults(null); setQ(''); } }} />;

  if (collapsed) {
    const name = shownBrief?.contact.name ?? current?.name ?? (day ? (calls.length ? 'No call selected' : 'No calls') : '…');
    return (
      <div className={`${host.kind === 'panel' ? 'h-full' : 'h-screen'} flex flex-col overflow-hidden`} data-testid="popout-root" data-collapsed="true" style={{ background: 'var(--bg-canvas)', color: 'var(--text-primary)', fontSize: 13 }}>
        <CollapsedBar name={name} time={current && !picked ? formatTime(current.startIso, tz) : ''} next={nextCallLabel(calls, index, tz)} chip={chip} onToggleCollapse={toggleCollapsed} dragHandle={host.dragHandle} />
      </div>
    );
  }

  const phase = log.phase;
  return (
    <div className={`${host.kind === 'panel' ? 'h-full' : 'h-screen'} flex flex-col overflow-hidden`} data-testid="popout-root" data-collapsed="false" style={{ background: 'var(--bg-canvas)', color: 'var(--text-primary)', fontSize: 13 }}>
      <PopOutHeader title={title} chip={chip} chipOpen={preview?.chipOpen} canPrev={calls.length > 0 && index !== 0} canNext={calls.length > 0 && index !== calls.length - 1} onPrev={() => step(-1)} onNext={() => step(1)} settings={settings} collapsed={false} onToggleCollapse={toggleCollapsed} onClose={host.onClose} dragHandle={host.dragHandle} />
      <BriefBlock brief={shownBrief} call={current} fromSearch={Boolean(picked)} onBackToCall={() => setPicked(null)} timezone={tz} loading={briefLoading} />
      <div className="flex-1 min-h-0 flex flex-col gap-2 px-3 pt-1.5 pb-1" data-testid="popout-body">
        {phase.kind === 'result' ? (
          <ResultSteps action={phase.action} busy={log.busy} onRetry={log.retry} timezone={tz} />
        ) : (
          <>
            <OutcomeGrid log={log} hasCall={call !== null} />
            <NoteField log={log} />
            <LastNote notes={shownBrief?.notes ?? null} />
          </>
        )}
      </div>
      <LogFooter log={log} hasCall={call !== null} hasTarget={target !== null} timezone={tz} />
    </div>
  );
};
