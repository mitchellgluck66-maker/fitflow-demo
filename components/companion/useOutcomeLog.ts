'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, FetchJsonError } from '@/lib/clientFetch';
import type { CompanionCall } from '@/lib/companion/day';
import type { OutcomesForCall } from '@/lib/companion/outcomeService';
import type { ActionView, LogPlan } from '@/lib/companion/log';
import { NOTE_MIN_CHARS } from '@/lib/companion/logText';
import type { EffectInput, PopOutProblem } from '@/lib/companion/popoutState';

export type LogPhase = { kind: 'pick' } | { kind: 'confirm'; plan: LogPlan; requestId: string; stale: { stageId: string | null; stageName: string | null } | null } | { kind: 'running'; plan: LogPlan } | { kind: 'result'; action: ActionView };
export type OutcomeChoice = { key: string } | { move: { stageId: string; appointment: 'showed' | 'noshow' | 'cancelled' | 'leave' } };

/** A canned state for the screenshots (GET /api/companion/preview, COMPANION_PREVIEW=1 only). */
export interface PopOutPreview {
  phase: LogPhase;
  outcomes: OutcomesForCall;
  note?: string;
  choice?: OutcomeChoice;
  problems?: PopOutProblem[];
  chipOpen?: boolean;
}

interface LogState {
  targetKey: string | null;
  /** The canned state the log was initialised from — a new preview re-initialises (screenshots only). */
  preview: PopOutPreview | null;
  phase: LogPhase;
  choice: OutcomeChoice | null;
  note: string;
  busy: 'plan' | 'confirm' | 'retry' | 'undo' | null;
  error: string | null;
}

const initial = (targetKey: string | null, preview: PopOutPreview | null | undefined): LogState => ({ targetKey, preview: preview ?? null, phase: preview?.phase ?? { kind: 'pick' }, choice: preview?.choice ?? null, note: preview?.note ?? '', busy: null, error: null });

const mintRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

function useCountdown(untilIso: string | null): string | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!untilIso) return;
    const tick = () => setLeft(Math.max(0, Date.parse(untilIso) - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [untilIso]);
  if (left === null || !untilIso) return null;
  const s = Math.floor(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Stage 2's outcome log as a hook (stage 4 moved the rendering into the pop-out's grid + footer). The write path is
 * byte-identical: plan → confirm (same request id on a stale-stage 409) → result; retry; undo. The state resets when
 * the target (person + call) changes — derived during render, never in an effect.
 */
export function useOutcomeLog(p: { targetKey: string | null; ghlContactId: string | null; call: CompanionCall | null; existingActionId: string | null; onChanged: () => void; preview?: PopOutPreview | null }) {
  const [fetched, setOutcomes] = useState<OutcomesForCall | null>(null);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);
  const [log, setLog] = useState<LogState>(() => initial(p.targetKey, p.preview));
  if (log.targetKey !== p.targetKey || log.preview !== (p.preview ?? null)) setLog(initial(p.targetKey, p.preview));
  const outcomes = p.preview?.outcomes ?? fetched;

  const callType = p.call?.callType ?? 'Other';
  const preview = p.preview;

  // The outcomes for this call type (and the dry-run flag).
  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    fetchJson<OutcomesForCall>(`/api/companion/outcomes?callType=${callType}`)
      .then((o) => {
        if (cancelled) return;
        setOutcomes(o);
        setOutcomesError(null);
      })
      .catch((e) => !cancelled && setOutcomesError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [callType, preview]);

  // A call already logged today opens on its result.
  const existingActionId = p.existingActionId;
  const targetKey = p.targetKey;
  useEffect(() => {
    if (preview || !existingActionId) return;
    let cancelled = false;
    fetchJson<{ action: ActionView }>(`/api/companion/actions/${existingActionId}`)
      .then((r) => !cancelled && setLog((s) => (s.targetKey === targetKey && s.phase.kind === 'pick' ? { ...s, phase: { kind: 'result', action: r.action } } : s)))
      .catch((e) => !cancelled && setLog((s) => (s.targetKey === targetKey ? { ...s, error: `Could not read the existing log: ${e instanceof Error ? e.message : String(e)}` } : s)));
    return () => {
      cancelled = true;
    };
  }, [existingActionId, preview, targetKey]);

  const noteLen = log.note.trim().length;
  const noteOk = noteLen >= NOTE_MIN_CHARS;
  const canLog = Boolean(log.choice) && noteOk && log.busy === null;
  const call = p.call;
  const callContext = useMemo(() => (call ? { eventId: call.eventId, ghlStatus: call.ghlStatus, startIso: call.startIso, callType: call.callType, calendarName: call.calendarName } : null), [call]);
  const ghlContactId = p.ghlContactId;
  const onChanged = p.onChanged;

  const patch = useCallback((f: (s: LogState) => LogState) => setLog((s) => f(s)), []);

  const plan = useCallback(async () => {
    const { choice, note } = log;
    if (!choice || !ghlContactId) return;
    patch((s) => ({ ...s, busy: 'plan', error: null }));
    try {
      const r = await fetchJson<{ plan: LogPlan }>('/api/companion/actions/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: ghlContactId, call: callContext, outcome: choice, note }) });
      patch((s) => ({ ...s, busy: null, phase: { kind: 'confirm', plan: r.plan, requestId: mintRequestId(), stale: null } }));
    } catch (e) {
      patch((s) => ({ ...s, busy: null, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [log, ghlContactId, callContext, patch]);

  const confirm = useCallback(async () => {
    const { phase, choice, note } = log;
    if (phase.kind !== 'confirm' || !choice || !ghlContactId) return;
    const { plan: pl, requestId, stale } = phase;
    patch((s) => ({ ...s, busy: 'confirm', error: null, phase: { kind: 'running', plan: pl } }));
    try {
      const r = await fetchJson<{ action: ActionView }>('/api/companion/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, contact: ghlContactId, call: callContext, outcome: choice, note, expectedStageId: pl.expectedStageId, acceptedStageId: stale?.stageId ?? null }),
      });
      patch((s) => ({ ...s, busy: null, phase: { kind: 'result', action: r.action } }));
      onChanged();
    } catch (e) {
      if (e instanceof FetchJsonError && e.status === 409) {
        // The stage moved in GHL since the sheet opened: ask before continuing (same request id).
        const body = (e.body ?? {}) as { staleStage?: { stageId: string | null; stageName: string | null } };
        patch((s) => ({ ...s, busy: null, phase: { kind: 'confirm', plan: pl, requestId, stale: body.staleStage ?? { stageId: null, stageName: null } } }));
      } else {
        patch((s) => ({ ...s, busy: null, phase: { kind: 'confirm', plan: pl, requestId, stale: null }, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, [log, ghlContactId, callContext, onChanged, patch]);

  const act = useCallback(
    async (kind: 'retry' | 'undo') => {
      const { phase } = log;
      if (phase.kind !== 'result') return;
      patch((s) => ({ ...s, busy: kind, error: null }));
      try {
        const r = await fetchJson<{ action: ActionView }>(`/api/companion/actions/${phase.action.id}/${kind}`, { method: 'POST' });
        patch((s) => ({ ...s, busy: null, phase: { kind: 'result', action: r.action } }));
        onChanged();
      } catch (e) {
        patch((s) => ({ ...s, busy: null, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [log, onChanged, patch],
  );

  const cancel = useCallback(() => patch((s) => ({ ...s, phase: { kind: 'pick' }, error: null })), [patch]);
  const reset = useCallback(() => patch((s) => ({ ...s, phase: { kind: 'pick' }, choice: null, note: '', error: null })), [patch]);
  const setChoice = useCallback((choice: OutcomeChoice | null) => patch((s) => ({ ...s, choice })), [patch]);
  const setNote = useCallback((note: string) => patch((s) => ({ ...s, note })), [patch]);

  const countdown = useCountdown(log.phase.kind === 'result' && log.phase.action.canUndo ? log.phase.action.undoUntil : null);
  const dryRun = outcomes?.dryRun.on ?? false;

  /** The picked outcome's effect, for the footer line. */
  const selected: EffectInput | null = useMemo(() => {
    const c = log.choice;
    if (!c || !outcomes) return null;
    if ('key' in c) {
      const o = outcomes.outcomes.find((x) => x.key === c.key);
      return o ? { toStage: o.toStage, appointment: o.appointment, opportunityStatus: o.opportunityStatus } : null;
    }
    const stage = outcomes.moveTo.stages.find((s) => s.id === c.move.stageId);
    return { toStage: stage ? { name: stage.name } : null, appointment: c.move.appointment, opportunityStatus: null };
  }, [log.choice, outcomes]);

  /** What the chip must know: the outcomes could not load; a step failed in GHL; a FitFlow call failed. */
  const problems: PopOutProblem[] = useMemo(() => {
    const list: PopOutProblem[] = [];
    if (outcomesError) list.push({ kind: 'app', detail: `Could not load the outcomes: ${outcomesError}` });
    if (log.phase.kind === 'result' && (log.phase.action.state === 'partial' || log.phase.action.state === 'failed')) list.push({ kind: 'ghl', detail: log.phase.action.error ?? `The ${log.phase.action.failedStep ?? 'log'} step failed in GoHighLevel` });
    if (log.error) list.push({ kind: log.error.startsWith('GHL ') ? 'ghl' : 'app', detail: log.error });
    return list;
  }, [outcomesError, log.phase, log.error]);

  return { outcomes, outcomesError, phase: log.phase, choice: log.choice, note: log.note, busy: log.busy, error: log.error, noteLen, noteOk, canLog, dryRun, selected, countdown, problems, plan, confirm, cancel, reset, setChoice, setNote, retry: () => act('retry'), undo: () => act('undo') };
}

export type OutcomeLog = ReturnType<typeof useOutcomeLog>;
