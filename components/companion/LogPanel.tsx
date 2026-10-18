'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Minus, RotateCcw, Undo2, Loader2, AlertTriangle } from 'lucide-react';
import { fetchJson, FetchJsonError } from '@/lib/clientFetch';
import { formatTime } from '@/lib/day';
import type { CompanionCall } from '@/lib/companion/day';
import type { OutcomesForCall } from '@/lib/companion/outcomeService';
import type { ActionView, LogPlan } from '@/lib/companion/log';
import { NOTE_MIN_CHARS } from '@/lib/companion/logText';

export type LogPhase = { kind: 'pick' } | { kind: 'confirm'; plan: LogPlan; requestId: string; stale: { stageId: string | null; stageName: string | null } | null } | { kind: 'running'; plan: LogPlan } | { kind: 'result'; action: ActionView };

export interface LogPanelPreview {
  phase: LogPhase;
  outcomes: OutcomesForCall;
  note?: string;
}

/** Remount per person / call (the pop-out keys it by contact + event) so a new target starts at "pick". */
interface Props {
  ghlContactId: string;
  call: CompanionCall | null;
  timezone: string;
  /** The newest live log for the call (from the day), shown on open. */
  existingActionId: string | null;
  onChanged: () => void;
  onDryRun: (on: boolean) => void;
  preview?: LogPanelPreview | null;
}

const mintRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const StepIcon: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'ok') return <Check size={13} strokeWidth={2.5} style={{ color: 'var(--success)' }} aria-label="done" />;
  if (status === 'failed') return <X size={13} strokeWidth={2.5} style={{ color: 'var(--danger)' }} aria-label="failed" />;
  if (status === 'dry_run') return <Check size={13} strokeWidth={2.5} style={{ color: 'var(--warning)' }} aria-label="dry run" />;
  if (status === 'pending') return <Loader2 size={13} className="animate-spin" style={{ color: 'var(--text-quaternary)' }} aria-label="pending" />;
  return <Minus size={13} strokeWidth={2.5} style={{ color: 'var(--text-quaternary)' }} aria-label="skipped" />;
};

function useCountdown(untilIso: string | null): string | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!untilIso) return;
    const tick = () => setLeft(Math.max(0, Date.parse(untilIso) - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [untilIso]);
  if (left === null) return null;
  const s = Math.floor(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The outcome area of the pop-out (stage 2): outcome buttons for the call's type (+ Move to…), the required note,
 * the confirmation sheet, the three per-step checks with Retry on the failing step, and Undo for 5 minutes.
 */
export const LogPanel: React.FC<Props> = ({ ghlContactId, call, timezone, existingActionId, onChanged, onDryRun, preview }) => {
  const [outcomes, setOutcomes] = useState<OutcomesForCall | null>(preview?.outcomes ?? null);
  const [phase, setPhase] = useState<LogPhase>(preview?.phase ?? { kind: 'pick' });
  const [choice, setChoice] = useState<{ key: string } | { move: { stageId: string; appointment: 'showed' | 'noshow' | 'cancelled' | 'leave' } } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [note, setNote] = useState(preview?.note ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callType = call?.callType ?? 'Other';

  // The outcomes for this call type (and the dry-run flag the banner shows).
  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    fetchJson<OutcomesForCall>(`/api/companion/outcomes?callType=${callType}`)
      .then((o) => {
        if (cancelled) return;
        setOutcomes(o);
        onDryRun(o.dryRun.on);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [callType, preview, onDryRun]);

  // A call already logged today opens on its result.
  useEffect(() => {
    if (preview || !existingActionId) return;
    let cancelled = false;
    fetchJson<{ action: ActionView }>(`/api/companion/actions/${existingActionId}`)
      .then((r) => !cancelled && setPhase({ kind: 'result', action: r.action }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [existingActionId, preview]);

  const noteLen = note.trim().length;
  const noteOk = noteLen >= NOTE_MIN_CHARS;
  const canLog = Boolean(choice) && noteOk && busy === null;

  const callContext = useMemo(() => (call ? { eventId: call.eventId, ghlStatus: call.ghlStatus, startIso: call.startIso, callType: call.callType, calendarName: call.calendarName } : null), [call]);

  const plan = async () => {
    if (!choice) return;
    setBusy('plan');
    setError(null);
    try {
      const r = await fetchJson<{ plan: LogPlan }>('/api/companion/actions/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: ghlContactId, call: callContext, outcome: choice, note }) });
      setPhase({ kind: 'confirm', plan: r.plan, requestId: mintRequestId(), stale: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (acceptedStageId: string | null) => {
    if (phase.kind !== 'confirm' || !choice) return;
    const { plan: p, requestId } = phase;
    setBusy('confirm');
    setError(null);
    setPhase({ kind: 'running', plan: p });
    try {
      const r = await fetchJson<{ action: ActionView }>('/api/companion/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, contact: ghlContactId, call: callContext, outcome: choice, note, expectedStageId: p.expectedStageId, acceptedStageId }),
      });
      setPhase({ kind: 'result', action: r.action });
      onChanged();
    } catch (e) {
      if (e instanceof FetchJsonError && e.status === 409) {
        // The stage moved in GHL since the sheet opened: ask before continuing (same request id).
        const body = (e.body ?? {}) as { staleStage?: { stageId: string | null; stageName: string | null } };
        setPhase({ kind: 'confirm', plan: p, requestId, stale: body.staleStage ?? { stageId: null, stageName: null } });
      } else {
        setPhase({ kind: 'confirm', plan: p, requestId, stale: null });
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'retry' | 'undo') => {
    if (phase.kind !== 'result') return;
    setBusy(kind);
    setError(null);
    try {
      const r = await fetchJson<{ action: ActionView }>(`/api/companion/actions/${phase.action.id}/${kind}`, { method: 'POST' });
      setPhase({ kind: 'result', action: r.action });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const reset = useCallback(() => {
    setPhase({ kind: 'pick' });
    setChoice(null);
    setNote('');
    setError(null);
  }, []);

  const countdown = useCountdown(phase.kind === 'result' && phase.action.canUndo ? phase.action.undoUntil : null);
  const dryRun = outcomes?.dryRun.on ?? false;

  // ---- result ----------------------------------------------------------------------------------------------------
  if (phase.kind === 'result') {
    const a = phase.action;
    const tone = a.state === 'ok' ? 'var(--success)' : a.state === 'dry_run' ? 'var(--warning)' : a.state === 'undone' ? 'var(--text-tertiary)' : 'var(--danger)';
    const title = a.state === 'ok' ? 'Logged' : a.state === 'dry_run' ? 'Dry run — logged, not sent' : a.state === 'undone' ? `Undone${a.undoneBy ? ` by ${a.undoneBy}` : ''}` : a.state === 'partial' ? 'Partly applied' : a.state === 'running' ? 'Logging…' : 'Failed';
    return (
      <section aria-label="Outcome" data-testid="log-result" data-state={a.state} className="rounded-[8px] px-2.5 py-2 space-y-2" style={{ border: `1px solid ${tone}`, background: 'var(--surface-raised)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-semibold" style={{ color: tone }}>
            {title} · {a.label}
          </div>
          <div className="text-[10.5px] tabular" style={{ color: 'var(--text-quaternary)' }}>
            {formatTime(a.createdAt, timezone)} · {a.userName}
          </div>
        </div>
        <ul className="space-y-1" aria-label="Steps">
          {a.steps.map((s) => (
            <li key={s.name} className="flex items-start gap-1.5 text-[12px]">
              <span className="mt-0.5 shrink-0">
                <StepIcon status={s.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className={s.status === 'skipped' ? '' : 'font-medium'} style={{ color: s.status === 'skipped' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                  {s.summary}
                  {s.status === 'dry_run' && <span style={{ color: 'var(--warning)' }}> · dry run — not sent</span>}
                </div>
                {s.detail && (
                  <div className="text-[11px] break-words" style={{ color: s.status === 'failed' ? 'var(--danger)' : 'var(--text-quaternary)' }}>
                    {s.detail}
                  </div>
                )}
              </div>
              {s.status === 'failed' && a.canRetry && (
                <button type="button" onClick={() => act('retry')} disabled={busy !== null} className="shrink-0 inline-flex items-center gap-1 h-6 px-1.5 rounded-[5px] text-[11px] font-medium focus-ring" style={{ background: 'var(--danger-muted, var(--negative-muted))', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                  <RotateCcw size={11} /> {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </li>
          ))}
        </ul>
        {a.error && (
          <p className="text-[11.5px] flex items-start gap-1.5" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {a.error}
          </p>
        )}
        {error && <p className="text-[11.5px]" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {a.canUndo && (
            <button type="button" onClick={() => act('undo')} disabled={busy !== null} className="inline-flex items-center gap-1 h-7 px-2 rounded-[6px] text-[11.5px] font-medium focus-ring" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
              <Undo2 size={12} /> {busy === 'undo' ? 'Undoing…' : `Undo${countdown ? ` (${countdown})` : ''}`}
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={reset} className="h-7 px-2 rounded-[6px] text-[11.5px] focus-ring" style={{ color: 'var(--text-tertiary)' }}>
            Log another
          </button>
        </div>
      </section>
    );
  }

  // ---- confirm / running --------------------------------------------------------------------------------------
  if (phase.kind === 'confirm' || phase.kind === 'running') {
    const p = phase.plan;
    const running = phase.kind === 'running';
    const stale = phase.kind === 'confirm' ? phase.stale : null;
    return (
      <section aria-label="Confirm the outcome" data-testid="log-confirm" className="rounded-[8px] px-2.5 py-2 space-y-2" style={{ border: '1px solid var(--accent)', background: 'var(--surface-raised)' }}>
        <div className="text-[12.5px] font-semibold">Confirm · {p.outcome.label}</div>
        <p className="text-[12px] leading-snug" style={{ color: 'var(--text-primary)' }}>
          {p.confirmation}
        </p>
        <ul className="space-y-0.5 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
          {p.steps.map((s) => (
            <li key={s.name} className="flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0">{s.skipReason ? <Minus size={12} style={{ color: 'var(--text-quaternary)' }} /> : <Check size={12} style={{ color: 'var(--accent)' }} />}</span>
              <span>
                {s.summary}
                {s.skipReason ? <span style={{ color: 'var(--text-quaternary)' }}> ({s.skipReason})</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <details className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
          <summary className="cursor-pointer select-none">Note as it will appear in GoHighLevel</summary>
          <pre className="whitespace-pre-wrap break-words mt-1 rounded-[6px] px-2 py-1.5" style={{ background: 'var(--surface-sunken)', fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
            {p.noteText}
          </pre>
        </details>
        {stale && (
          <div role="alert" className="text-[12px] rounded-[6px] px-2 py-1.5" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}>
            Stage changed to <strong>{stale.stageName ?? 'another stage'}</strong> since you opened this — continue?
          </div>
        )}
        {error && <p className="text-[11.5px]" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setPhase({ kind: 'pick' })} disabled={running} className="h-7 px-2 rounded-[6px] text-[11.5px] focus-ring" style={{ color: 'var(--text-tertiary)' }}>
            Cancel
          </button>
          <div className="flex-1" />
          <button type="button" onClick={() => confirm(stale?.stageId ?? null)} disabled={running} data-testid="log-confirm-button" className="inline-flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[11.5px] font-semibold focus-ring disabled:opacity-60" style={{ background: p.dryRun ? 'var(--warning)' : 'var(--accent)', color: '#fff' }}>
            {running ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Logging…
              </>
            ) : stale ? (
              'Continue anyway'
            ) : p.dryRun ? (
              'Confirm (dry run)'
            ) : (
              'Confirm'
            )}
          </button>
        </div>
      </section>
    );
  }

  // ---- pick -------------------------------------------------------------------------------------------------------
  const list = outcomes?.outcomes ?? [];
  const move = outcomes?.moveTo;
  const selectedMove = choice && 'move' in choice ? choice.move : null;
  return (
    <section aria-label="Outcome" data-testid="log-pick" className="rounded-[8px] px-2.5 py-2 space-y-2" style={{ border: '1px solid var(--border-default)' }}>
      <div className="flex items-center justify-between text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
        <span>Outcome{call ? ` · ${callType === 'Other' ? call.calendarName : callType}` : ' · no call'}</span>
        {dryRun && <span style={{ color: 'var(--warning)' }}>dry run</span>}
      </div>
      {!outcomes && !error && (
        <p className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
          Loading outcomes…
        </p>
      )}
      {list.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {list.map((o) => {
            const on = choice && 'key' in choice && choice.key === o.key;
            return (
              <button
                key={o.key}
                type="button"
                disabled={Boolean(o.unavailable)}
                title={o.unavailable ?? (o.toStage ? `→ ${o.toStage.name} · appointment ${o.appointment}` : `appointment ${o.appointment}`)}
                onClick={() => {
                  setChoice({ key: o.key });
                  setMoveOpen(false);
                }}
                className="h-7 px-2 rounded-[6px] text-[11.5px] font-medium truncate focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: on ? 'var(--accent)' : 'var(--surface-raised)', color: on ? '#fff' : 'var(--text-primary)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}` }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
      {move && (
        <div>
          <button
            type="button"
            onClick={() => setMoveOpen((v) => !v)}
            disabled={!move.pipeline}
            title={move.pipeline ? `Any stage of ${move.pipeline.name}` : 'Follow a pipeline in Setup first'}
            className="h-7 px-2 rounded-[6px] text-[11.5px] font-medium focus-ring disabled:opacity-50"
            style={{ background: selectedMove ? 'var(--accent)' : 'var(--surface-raised)', color: selectedMove ? '#fff' : 'var(--text-primary)', border: `1px solid ${selectedMove ? 'var(--accent)' : 'var(--border-subtle)'}` }}
          >
            Move to…{selectedMove ? ` ${move.stages.find((s) => s.id === selectedMove.stageId)?.name ?? ''}` : ''}
          </button>
          {moveOpen && move.pipeline && (
            <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-1.5">
              <select aria-label="Move to stage" value={selectedMove?.stageId ?? ''} onChange={(e) => setChoice(e.target.value ? { move: { stageId: e.target.value, appointment: selectedMove?.appointment ?? (call ? 'showed' : 'leave') } } : null)} className="h-7 rounded-[6px] px-1.5 text-[11.5px]" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                <option value="">Pick a stage…</option>
                {move.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select aria-label="Move to appointment status" value={selectedMove?.appointment ?? (call ? 'showed' : 'leave')} disabled={!selectedMove || !call} onChange={(e) => selectedMove && setChoice({ move: { stageId: selectedMove.stageId, appointment: e.target.value as 'showed' } })} className="h-7 rounded-[6px] px-1.5 text-[11.5px]" style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                {move.appointments.map((a) => (
                  <option key={a} value={a}>
                    {a === 'noshow' ? 'no-show' : a === 'leave' ? 'leave appointment' : a}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      <div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Call notes (required) — what happened, what was agreed, next step"
          aria-label="Call note"
          className="w-full rounded-[6px] px-2 py-1.5 text-[12px] leading-snug focus-ring"
          style={{ background: 'var(--surface)', border: `1px solid ${note && !noteOk ? 'var(--warning)' : 'var(--border-default)'}`, color: 'var(--text-primary)' }}
        />
        <div className="flex items-center justify-between text-[10.5px] tabular" style={{ color: noteOk ? 'var(--text-quaternary)' : 'var(--warning)' }}>
          <span>{noteOk ? 'Note ready' : `${noteLen} / ${NOTE_MIN_CHARS} characters`}</span>
          {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
        </div>
      </div>
      <button type="button" onClick={plan} disabled={!canLog} data-testid="log-button" className="w-full h-8 rounded-[6px] text-[12px] font-semibold focus-ring disabled:opacity-50" style={{ background: 'var(--accent)', color: '#fff' }}>
        {busy === 'plan' ? 'Preparing…' : 'Log'}
      </button>
    </section>
  );
};
