'use client';

/**
 * The Analyst panel's state and transport (Wave 2 item 4b). One shared history (no identity): threads come from
 * GET /api/analyst/threads; a turn is POST /api/analyst/turns, then its events are read as SSE from
 * GET /api/analyst/turns/[id]/events?after=N and folded by lib/analyst/clientState (pure). The run is not the
 * connection: a dropped stream (locked phone, tab switch) reconnects from the last event index; a `continue` event
 * calls …/continue and reconnects; a cost confirmation re-posts with the confirmed amount. Nothing here renders.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useBusinessTimezone } from '@/components/BusinessTimezone';
import { todayInTimezone } from '@/lib/day';
import { applyEvent, newTurnView, turnsFromTranscript, type ThreadTranscript, type TurnView } from '@/lib/analyst/clientState';
import { contextPillText, pageContextFor, type Selected } from '@/lib/analyst/pageContext';
import type { AnalystEvent } from '@/lib/analyst/run';
import type { PageContext } from '@/lib/analyst/prompts';

export interface AnalystSettingsLite {
  configured: boolean;
  modelDefault: string;
  briefBuilt: boolean;
  capRunUsd: number;
}

export interface FreshnessLite {
  stale: boolean;
  text: string;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  model: string;
  createdAt: string;
  lastTurnAt: string | null;
}

export interface AnalystApi {
  isOpen: boolean;
  open(): void;
  close(): void;
  threadId: string | null;
  turns: TurnView[];
  busy: boolean;
  settings: AnalystSettingsLite | null;
  settingsError: string | null;
  freshness: FreshnessLite | null;
  contextText: string;
  pageContext: PageContext;
  threads: ThreadSummary[];
  threadsLoading: boolean;
  view: 'chat' | 'threads';
  setView(v: 'chat' | 'threads'): void;
  ask(question: string, opts?: { selected?: Selected | null }): void;
  explain(metricKey: string, label: string): void;
  askAbout(selected: Selected, question: string): void;
  stop(): void;
  confirm(turn: TurnView): void;
  dismissConfirmation(turn: TurnView): void;
  retry(turn: TurnView): void;
  newConversation(): void;
  openThread(id: string): Promise<void>;
  refreshThreads(): Promise<void>;
  rebuildBrief(): Promise<void>;
  launcherRef: React.RefObject<HTMLButtonElement | null>;
}

const Ctx = createContext<AnalystApi | null>(null);

export function useAnalyst(): AnalystApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAnalyst must be used inside <AnalystProvider>');
  return v;
}

/** Safe outside the provider (a component rendered on /login or in a test): null instead of a throw. */
export function useAnalystOptional(): AnalystApi | null {
  return useContext(Ctx);
}

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Parse SSE frames (`id:` / `event:` / `data:`) out of a text stream; yields `{ id, event }`. */
async function* readSse(res: Response, signal: AbortSignal): AsyncGenerator<{ id: number; event: AnalystEvent }> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        let id = 0;
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || 0;
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          yield { id, event: JSON.parse(data) as AnalystEvent };
        } catch {
          /* a malformed frame is skipped; the next replay carries it again */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const TERMINAL = new Set(['done', 'failed', 'stopped', 'needs_confirmation']);

export function AnalystProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { timezone } = useBusinessTimezone();
  const [isOpen, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [settings, setSettings] = useState<AnalystSettingsLite | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessLite | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [view, setView] = useState<'chat' | 'threads'>('chat');
  const [selected, setSelected] = useState<Selected | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const streams = useRef(new Map<string, AbortController>());
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  const today = useMemo(() => todayInTimezone(timezone ?? 'UTC'), [timezone]);
  const previewState = search?.get('analystPreview') ?? null;
  const pageCtx = useMemo(() => pageContextFor(pathname ?? '/', search, today, selected), [pathname, search, today, selected]);
  const pageContext: PageContext = useMemo(() => ({ page: pageCtx.page, range: pageCtx.range, compare: pageCtx.compare, mode: pageCtx.mode, selected: pageCtx.selected }), [pageCtx]);
  const contextText = useMemo(() => contextPillText(pageCtx), [pageCtx]);

  const updateTurn = useCallback((clientTurnId: string, f: (t: TurnView) => TurnView) => {
    setTurns((ts) => ts.map((t) => (t.clientTurnId === clientTurnId ? f(t) : t)));
  }, []);

  const loadSettings = useCallback(async () => {
    if (previewState) return;
    try {
      const r = await fetch('/api/analyst/settings', { cache: 'no-store' });
      const j = (await r.json()) as { configured: boolean; modelDefault: string; capRunUsd: number; brief: { built: boolean }; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSettings({ configured: j.configured, modelDefault: j.modelDefault, briefBuilt: Boolean(j.brief?.built), capRunUsd: j.capRunUsd });
      setSettingsError(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, [previewState]);

  const loadFreshness = useCallback(async () => {
    if (previewState) return;
    try {
      const r = await fetch('/api/sync/status', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { scheduler?: { silent: boolean }; staleSources?: Array<{ label: string; ageHours: number | null }>; sources?: Array<{ configured: boolean; ageHours: number | null }> };
      const age = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
      if (j.scheduler?.silent) setFreshness({ stale: true, text: 'scheduler silent' });
      else if (j.staleSources?.length) setFreshness({ stale: true, text: j.staleSources.map((s) => `${s.label} stale${s.ageHours !== null ? ` ${age(s.ageHours)}` : ''}`).join(', ') });
      else {
        const configured = (j.sources ?? []).filter((s) => s.configured && s.ageHours !== null);
        const newest = configured.length ? Math.max(...configured.map((s) => s.ageHours as number)) : null;
        setFreshness({ stale: false, text: newest === null ? 'no sources connected' : `data fresh ${age(newest)} ago` });
      }
    } catch {
      /* the pill keeps its last value */
    }
  }, [previewState]);

  const refreshThreads = useCallback(async () => {
    if (previewState) return; // the preview's list stays
    setThreadsLoading(true);
    try {
      const r = await fetch('/api/analyst/threads', { cache: 'no-store' });
      const j = (await r.json()) as { threads?: ThreadSummary[] };
      setThreads(j.threads ?? []);
    } finally {
      setThreadsLoading(false);
    }
  }, [previewState]);

  // --- the event stream -------------------------------------------------------------------------------------------
  const connect = useCallback(
    (clientTurnId: string, turnId: string, after: number, attempt = 0) => {
      streams.current.get(clientTurnId)?.abort();
      const controller = new AbortController();
      streams.current.set(clientTurnId, controller);
      (async () => {
        let last = after;
        let terminal = false;
        let wantContinue = false;
        try {
          const res = await fetch(`/api/analyst/turns/${turnId}/events?after=${after}`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'text/event-stream' } });
          if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
          for await (const { id, event } of readSse(res, controller.signal)) {
            last = id;
            updateTurn(clientTurnId, (t) => applyEvent(t, event, id));
            if (event.type === 'notice') setFreshness({ stale: event.stale, text: event.text.replace(/^STALE — /, '').replace(/^data fresh — /, '') });
            if (event.type === 'continue') wantContinue = true;
            if (event.type === 'done' || event.type === 'error' || (event.type === 'needs_confirmation')) terminal = true;
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          void err;
        }
        if (controller.signal.aborted) return;
        if (wantContinue) {
          try {
            const r = await fetch(`/api/analyst/turns/${turnId}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!r.ok) {
              const j = (await r.json().catch(() => ({}))) as { error?: string };
              updateTurn(clientTurnId, (t) => ({ ...t, status: 'failed', error: { message: `Analyst request failed: ${j.error ?? `continue HTTP ${r.status}`}`, retryable: true } }));
              return;
            }
          } catch (err) {
            updateTurn(clientTurnId, (t) => ({ ...t, status: 'failed', error: { message: `Analyst request failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true } }));
            return;
          }
          updateTurn(clientTurnId, (t) => ({ ...t, status: 'running' }));
          connect(clientTurnId, turnId, last, 0);
          return;
        }
        if (terminal) return;
        // The stream closed without a terminal event (the route's 280 s window, a dropped connection): reconnect from the last index.
        const t = turnsRef.current.find((x) => x.clientTurnId === clientTurnId);
        if (t && !TERMINAL.has(t.status)) setTimeout(() => connect(clientTurnId, turnId, last, attempt + 1), Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 3)));
      })();
    },
    [updateTurn],
  );

  // Reconnect running turns when the tab becomes visible again (the run outlived the connection).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      for (const t of turnsRef.current) if (t.id && !TERMINAL.has(t.status) && t.status !== 'starting' && !streams.current.has(t.clientTurnId)) connect(t.clientTurnId, t.id, t.lastEventIndex);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [connect]);

  // --- starting a turn ------------------------------------------------------------------------------------------------
  const startTurn = useCallback(
    async (p: { clientTurnId?: string; question: string; kind: TurnView['kind']; explainKey?: string | null; context: PageContext; confirmedUsd?: number | null }) => {
      const clientTurnId = p.clientTurnId ?? uuid();
      if (!p.clientTurnId) setTurns((ts) => [...ts, newTurnView({ clientTurnId, question: p.question, kind: p.kind })]);
      else updateTurn(clientTurnId, (t) => ({ ...t, status: 'starting', error: null, confirmation: null }));
      setView('chat');
      try {
        const r = await fetch('/api/analyst/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: threadRef.current, clientTurnId, question: p.question, kind: p.kind, context: p.context, explainKey: p.explainKey ?? null, confirmedUsd: p.confirmedUsd ?? null }) });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; threadId?: string | null; turnId?: string; model?: string; estimate?: { usd: number }; reason?: string; error?: string };
        if (j.threadId) setThreadId(j.threadId);
        if (r.ok && j.ok && j.turnId) {
          updateTurn(clientTurnId, (t) => ({ ...t, id: j.turnId!, status: 'running' }));
          connect(clientTurnId, j.turnId, 0);
          return;
        }
        if (j.status === 'needs_confirmation') {
          updateTurn(clientTurnId, (t) => ({ ...t, status: 'needs_confirmation', confirmation: { reason: j.reason ?? 'This run is above the cap', spentUsd: null, estimateUsd: j.estimate?.usd ?? null } }));
          return;
        }
        const message = r.status === 409 ? 'This thread is answering' : j.error ?? j.status ?? `HTTP ${r.status}`;
        updateTurn(clientTurnId, (t) => ({ ...t, status: 'failed', error: { message: `Analyst request failed: ${message}`, retryable: r.status !== 412 } }));
      } catch (err) {
        updateTurn(clientTurnId, (t) => ({ ...t, status: 'failed', error: { message: `Analyst request failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true } }));
      }
    },
    [connect, updateTurn],
  );

  const open = useCallback(() => {
    setOpen(true);
    void loadSettings();
    void loadFreshness();
  }, [loadSettings, loadFreshness]);
  const close = useCallback(() => {
    setOpen(false);
    setTimeout(() => launcherRef.current?.focus({ preventScroll: true }), 50);
  }, []);

  const ask = useCallback(
    (question: string, opts: { selected?: Selected | null } = {}) => {
      const q = question.trim();
      if (!q) return;
      const sel = opts.selected === undefined ? selected : opts.selected;
      const ctx = pageContextFor(pathname ?? '/', search, today, sel);
      void startTurn({ question: q, kind: 'ask', context: { page: ctx.page, range: ctx.range, compare: ctx.compare, mode: ctx.mode, selected: ctx.selected } });
    },
    [pathname, search, today, selected, startTurn],
  );

  const explain = useCallback(
    (metricKey: string, label: string) => {
      const sel: Selected = { kind: 'metric', id: metricKey, label };
      setSelected(sel);
      open();
      const ctx = pageContextFor(pathname ?? '/', search, today, sel);
      void startTurn({ question: `What does ${label} mean?`, kind: 'explain', explainKey: metricKey, context: { page: ctx.page, range: ctx.range, compare: ctx.compare, mode: ctx.mode, selected: sel } });
    },
    [open, pathname, search, today, startTurn],
  );

  const askAbout = useCallback(
    (sel: Selected, question: string) => {
      setSelected(sel);
      open();
      ask(question, { selected: sel });
    },
    [open, ask],
  );

  const stop = useCallback(() => {
    for (const t of turnsRef.current) if (t.id && (t.status === 'running' || t.status === 'continue')) void fetch(`/api/analyst/turns/${t.id}/stop`, { method: 'POST' });
  }, []);

  const confirm = useCallback(
    (turn: TurnView) => {
      const cap = settings?.capRunUsd ?? 3;
      if (!turn.id) {
        // Refused before it started: re-post the same client turn with the estimate confirmed.
        const amount = Math.max(turn.confirmation?.estimateUsd ?? cap, cap);
        void startTurn({ clientTurnId: turn.clientTurnId, question: turn.question, kind: turn.kind, explainKey: turn.kind === 'explain' ? (pageCtx.selected?.id ?? null) : null, context: pageContext, confirmedUsd: amount });
        return;
      }
      const amount = (turn.confirmation?.spentUsd ?? 0) + cap;
      updateTurn(turn.clientTurnId, (t) => ({ ...t, status: 'running', confirmation: null }));
      void fetch(`/api/analyst/turns/${turn.id}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedUsd: amount }) }).then((r) => {
        if (r.ok) connect(turn.clientTurnId, turn.id!, turn.lastEventIndex);
        else updateTurn(turn.clientTurnId, (t) => ({ ...t, status: 'failed', error: { message: `Analyst request failed: continue HTTP ${r.status}`, retryable: true } }));
      });
    },
    [settings, startTurn, pageCtx, pageContext, updateTurn, connect],
  );

  const dismissConfirmation = useCallback(
    (turn: TurnView) => {
      if (turn.id) void fetch(`/api/analyst/turns/${turn.id}/stop`, { method: 'POST' });
      setTurns((ts) => ts.filter((t) => t.clientTurnId !== turn.clientTurnId || t.id !== null).map((t) => (t.clientTurnId === turn.clientTurnId ? { ...t, status: 'stopped', confirmation: null } : t)));
    },
    [],
  );

  const retry = useCallback(
    (turn: TurnView) => {
      if (turn.id && turn.status === 'failed' && turn.error?.retryable) {
        // A failed turn resumes from its last completed round (…/continue); a turn that never started re-posts.
        updateTurn(turn.clientTurnId, (t) => ({ ...t, status: 'running', error: null }));
        void fetch(`/api/analyst/turns/${turn.id}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(async (r) => {
          if (r.ok) connect(turn.clientTurnId, turn.id!, turn.lastEventIndex);
          else void startTurn({ question: turn.question, kind: turn.kind, explainKey: turn.kind === 'explain' ? (pageCtx.selected?.id ?? null) : null, context: pageContext });
        });
        return;
      }
      void startTurn({ clientTurnId: turn.clientTurnId, question: turn.question, kind: turn.kind, explainKey: turn.kind === 'explain' ? (pageCtx.selected?.id ?? null) : null, context: pageContext });
    },
    [updateTurn, connect, startTurn, pageCtx, pageContext],
  );

  const newConversation = useCallback(() => {
    for (const c of streams.current.values()) c.abort();
    streams.current.clear();
    setThreadId(null);
    setTurns([]);
    setSelected(null);
    setView('chat');
  }, []);

  const openThread = useCallback(
    async (id: string) => {
      for (const c of streams.current.values()) c.abort();
      streams.current.clear();
      const r = await fetch(`/api/analyst/threads/${id}`, { cache: 'no-store' });
      if (!r.ok) return;
      const t = (await r.json()) as ThreadTranscript;
      setThreadId(t.thread.id);
      const views = turnsFromTranscript(t);
      setTurns(views);
      setView('chat');
      for (const v of views) if (v.id && v.status === 'running') connect(v.clientTurnId, v.id, v.lastEventIndex);
    },
    [connect],
  );

  const rebuildBrief = useCallback(async () => {
    await fetch('/api/analyst/brief', { method: 'POST' });
    await loadSettings();
  }, [loadSettings]);

  // Wave 2 item 8: `?analystPreview=<state>` loads a canned panel state for the screenshot harness. The route answers
  // only when the server runs with ANALYST_PREVIEW=1 outside production; anywhere else this is a silent no-op.
  useEffect(() => {
    if (!previewState) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/analyst/preview?state=${encodeURIComponent(previewState)}`, { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const p = (await r.json()) as { open: boolean; view: 'chat' | 'threads'; turns: TurnView[]; threads: ThreadSummary[]; freshness: FreshnessLite };
        setTurns(p.turns);
        setThreads(p.threads);
        setFreshness(p.freshness);
        setView(p.view);
        setSettings({ configured: true, modelDefault: 'claude-opus-5-5', briefBuilt: true, capRunUsd: 3 });
        if (p.open) setOpen(true);
      } catch {
        /* not a preview server */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewState]);

  // Esc closes; the body class condenses the page (padding-right on the app shell) while open.
  useEffect(() => {
    if (!isOpen) return;
    document.body.classList.add('panel-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('panel-open');
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, close]);

  const busy = turns.some((t) => t.status === 'starting' || t.status === 'running' || t.status === 'continue');

  const value: AnalystApi = useMemo(
    () => ({ isOpen, open, close, threadId, turns, busy, settings, settingsError, freshness, contextText, pageContext, threads, threadsLoading, view, setView, ask, explain, askAbout, stop, confirm, dismissConfirmation, retry, newConversation, openThread, refreshThreads, rebuildBrief, launcherRef }),
    [isOpen, open, close, threadId, turns, busy, settings, settingsError, freshness, contextText, pageContext, threads, threadsLoading, view, ask, explain, askAbout, stop, confirm, dismissConfirmation, retry, newConversation, openThread, refreshThreads, rebuildBrief],
  );

  // The gate has no chrome: nothing mounts on /login.
  if (pathname === '/login') return <>{children}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
