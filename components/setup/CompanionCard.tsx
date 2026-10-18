'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Headset, CheckCircle2, XCircle, Eye, EyeOff, Trash2, ShieldAlert, RotateCcw } from 'lucide-react';
import { AccordionCard, Badge, Button, Modal, Select, Toast, Toggle } from '@/components';
import { fetchJson } from '@/lib/clientFetch';
import { FetchError } from '@/components/FetchError';
import type { CompanionAdminState } from '@/lib/companion/admin';
import { APPOINTMENT_ACTION_LABELS, OPPORTUNITY_STATUS_LABELS, type AppointmentAction, type OutcomeOpportunityStatus } from '@/lib/companion/outcomes';
import { ROLE_LABELS, SEMANTIC_ROLES } from '@/lib/ghl/roles';

type ToastState = { message: string; detail?: string; type: 'success' | 'error' | 'info' } | null;

const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Setup → Companion (stage 2, owner only): the SEPARATE write key (masked, Verify), the dry-run switch (default on;
 * turning it off asks for a confirm), what a Reschedule does to the appointment, the outcome map (stage ROLE +
 * appointment + opportunity status per outcome, Reset to defaults) and the failed logs that need the owner.
 */
export const CompanionCard: React.FC = () => {
  const [state, setState] = useState<CompanionAdminState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [verification, setVerification] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => {
    fetchJson<CompanionAdminState>('/api/setup/companion')
      .then((d) => {
        setLoadError(null);
        setState(d);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load, attempt]);

  const saveKey = async (verifyOnly = false) => {
    setBusy('key');
    try {
      const r = await fetchJson<{ ok: boolean; verification: { ok: boolean; message: string } }>('/api/setup/companion/write-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verifyOnly ? { verify: true } : { token }),
      });
      setVerification(r.verification);
      setToast({ message: r.ok ? 'Write key verified' : 'Verification failed', detail: r.verification.message, type: r.ok ? 'success' : 'error' });
      setToken('');
      load();
    } catch (e) {
      setToast({ message: 'Could not save the write key', detail: e instanceof Error ? e.message : String(e), type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const forgetKey = async () => {
    setBusy('key');
    try {
      const r = await fetchJson<{ message: string }>('/api/setup/companion/write-key', { method: 'DELETE' });
      setVerification(null);
      setToast({ message: r.message, type: 'info' });
      load();
    } catch (e) {
      setToast({ message: 'Could not clear the write key', detail: e instanceof Error ? e.message : String(e), type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const patch = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      await fetchJson('/api/setup/companion', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setToast({ message: `${label} saved`, type: 'success' });
      load();
    } catch (e) {
      setToast({ message: `Could not save ${label.toLowerCase()}`, detail: e instanceof Error ? e.message : String(e), type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const setDryRun = (on: boolean) => {
    if (!on) {
      setConfirmOff(true);
      return;
    }
    void patch({ dryRun: true }, 'Dry run');
  };

  const keyOk = Boolean(state?.writeKey.configured && (verification ? verification.ok : true));
  const summary = !state
    ? 'Loading…'
    : [
        state.writeKey.configured ? (verification && !verification.ok ? 'write key failed verification' : 'write key saved') : 'no write key',
        state.dryRun.on ? 'dry run ON' : 'LIVE — writes to GoHighLevel',
        state.failedLogs.length ? `${state.failedLogs.length} failed log${state.failedLogs.length === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <AccordionCard
      title="Companion"
      summary={summary}
      subtitle="Outcome logging from the pop-out — the one path that writes to GoHighLevel, under its own key"
      icon={Headset}
      defaultOpen={Boolean(state && (!state.writeKey.configured || state.failedLogs.length > 0 || state.outcomeMap.warnings.length > 0 || state.dryRun.invalidValue))}
      action={
        state ? (
          <Badge variant={state.dryRun.on ? 'warning' : keyOk ? 'success' : 'danger'} dot>
            {state.dryRun.on ? 'Dry run' : keyOk ? 'Live' : 'Live · no key'}
          </Badge>
        ) : null
      }
    >
      {loadError && <FetchError title="Could not load the Companion settings" error={loadError} onRetry={() => setAttempt((a) => a + 1)} />}

      {state && (
        <div className="space-y-5">
          {/* Dry run */}
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-[8px]"
            style={{ background: state.dryRun.on ? 'var(--warning-muted)' : 'var(--success-muted)', border: `1px solid ${state.dryRun.on ? 'var(--warning-border)' : 'var(--success-border)'}` }}
          >
            <ShieldAlert size={14} strokeWidth={2.3} style={{ color: state.dryRun.on ? 'var(--warning)' : 'var(--success)' }} />
            <div className="flex-1 min-w-[200px] text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
              {state.dryRun.on ? (
                <>
                  <strong>Dry run</strong> — outcomes are logged in FitFlow with the exact requests, nothing is sent to GoHighLevel.
                  {state.dryRun.invalidValue && <span style={{ color: 'var(--warning)' }}> (stored value “{state.dryRun.invalidValue}” is not valid — read as on)</span>}
                </>
              ) : (
                <>
                  <strong>Live</strong> — a confirmed log moves the stage, sets the appointment status and adds the note in GoHighLevel.
                </>
              )}
            </div>
            <Toggle checked={!state.dryRun.on} onChange={(live) => setDryRun(!live)} label="Send to GoHighLevel" disabled={busy === 'Dry run'} />
          </div>

          {/* Write key */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Companion write key
              </h4>
              {state.writeKey.configured && (
                <Badge variant={keyOk ? 'success' : 'warning'} size="xs" dot>
                  {keyOk ? 'Verified' : 'Saved — not verified'}
                </Badge>
              )}
            </div>
            {state.writeKey.configured ? (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-[8px] text-[12.5px]" style={{ background: keyOk ? 'var(--success-muted)' : 'var(--warning-muted)', border: `1px solid ${keyOk ? 'var(--success-border)' : 'var(--warning-border)'}` }}>
                {keyOk ? <CheckCircle2 size={14} style={{ color: 'var(--success)' }} /> : <XCircle size={14} style={{ color: 'var(--warning)' }} />}
                <span>
                  Key <strong>{state.writeKey.preview}</strong>
                  {verification ? ` — ${verification.message}` : ' · press Verify to check it against the location'}
                </span>
              </div>
            ) : (
              <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
                No write key. Every log attempt is refused until one is saved here — the read-only key is never used for a write.
              </p>
            )}
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={state.writeKey.configured ? 'Saved — paste a new key to replace' : 'pit-… (a second Private Integration Token with the write scopes)'}
                aria-label="Companion write key"
                autoComplete="off"
                spellCheck={false}
                className="w-full h-8 pl-2.5 pr-9 text-[13px] rounded-[7px]"
                style={{ fontFamily: 'var(--font-jetbrains)' }}
              />
              <button type="button" onClick={() => setShowToken((v) => !v)} aria-label={showToken ? 'Hide key' : 'Show key'} className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-[5px] hover:bg-[var(--surface-hover)]" style={{ color: 'var(--text-quaternary)' }}>
                {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <p className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              Scopes: opportunities.write · calendars/events.write · contacts.write (+ the read scopes). Verify proves the key authenticates to the location; the write scopes are proven only by <code>npm run companion:live-test</code>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" loading={busy === 'key'} disabled={!token.trim()} onClick={() => saveKey(false)}>
                Save &amp; verify
              </Button>
              <Button loading={busy === 'key'} disabled={!state.writeKey.configured || Boolean(token.trim())} onClick={() => saveKey(true)}>
                Verify
              </Button>
              {state.writeKey.configured && (
                <Button variant="ghost" icon={Trash2} disabled={busy === 'key'} onClick={forgetKey}>
                  Forget key
                </Button>
              )}
            </div>
          </section>

          {/* Outcome map */}
          <section className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Outcome map
              </h4>
              <div className="flex items-center gap-2">
                <Select aria-label="Reschedule rule" value={state.rescheduleAppointment} onChange={(e) => patch({ rescheduleAppointment: e.target.value }, 'Reschedule rule')}>
                  <option value="cancelled">Reschedule → appointment cancelled</option>
                  <option value="leave">Reschedule → appointment left as is</option>
                </Select>
                <Button variant="ghost" icon={RotateCcw} disabled={!state.outcomeMap.overridden.length || busy === 'Outcome map'} onClick={() => patch({ outcomeMap: {} }, 'Outcome map')}>
                  Reset to defaults
                </Button>
              </div>
            </div>
            {state.outcomeMap.warnings.map((w) => (
              <p key={w} className="text-[12px] px-3 py-1.5 rounded-[8px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}>
                {w}
              </p>
            ))}
            <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
              Stages are named by ROLE and resolved from the followed pipeline&apos;s stage map at log time (Setup → Pipelines). “Move to…” in the pop-out offers every stage of that pipeline.
            </p>
            <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }}>
                    <th className="text-left px-2.5 py-1.5 font-medium">Call</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Outcome</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Stage (role)</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Appointment</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Opportunity</th>
                    <th className="text-left px-2.5 py-1.5 font-medium">Resolves to</th>
                  </tr>
                </thead>
                <tbody>
                  {state.outcomeMap.outcomes.map((o) => {
                    const overridden = state.outcomeMap.overridden.includes(o.key);
                    const send = (field: 'stageRole' | 'appointment' | 'opportunityStatus', value: string) =>
                      patch({ outcomeMap: { ...state.outcomeMap.overridesRaw, [o.key]: { stageRole: o.stageRole, appointment: o.appointment, opportunityStatus: o.opportunityStatus, [field]: value === '' ? null : value } } }, 'Outcome map');
                    return (
                      <tr key={o.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <td className="px-2.5 py-1.5" style={{ color: 'var(--text-tertiary)' }}>{o.callType}</td>
                        <td className="px-2.5 py-1.5 font-medium">
                          {o.label}
                          {overridden && (
                            <Badge variant="accent" size="xs" className="ml-1.5">
                              edited
                            </Badge>
                          )}
                        </td>
                        <td className="px-2.5 py-1">
                          <Select aria-label={`${o.label} stage`} value={o.stageRole ?? ''} onChange={(e) => send('stageRole', e.target.value)}>
                            <option value="">unchanged</option>
                            {SEMANTIC_ROLES.filter((r) => r !== 'other').map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-2.5 py-1">
                          <Select aria-label={`${o.label} appointment`} value={o.appointment} onChange={(e) => send('appointment', e.target.value)}>
                            {(Object.keys(APPOINTMENT_ACTION_LABELS) as AppointmentAction[]).map((a) => (
                              <option key={a} value={a}>
                                {APPOINTMENT_ACTION_LABELS[a]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-2.5 py-1">
                          <Select aria-label={`${o.label} opportunity`} value={o.opportunityStatus ?? ''} onChange={(e) => send('opportunityStatus', e.target.value)}>
                            <option value="">unchanged</option>
                            {(Object.keys(OPPORTUNITY_STATUS_LABELS) as OutcomeOpportunityStatus[]).map((s) => (
                              <option key={s} value={s}>
                                {OPPORTUNITY_STATUS_LABELS[s]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-2.5 py-1.5" style={{ color: o.resolvedStage ? 'var(--text-secondary)' : o.stageRole ? 'var(--warning)' : 'var(--text-quaternary)' }}>
                          {o.resolvedStage ? o.resolvedStage.name : o.stageRole ? `no stage mapped to ${ROLE_LABELS[o.stageRole]}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              Followed pipeline: {state.outcomeMap.pipeline ? `${state.outcomeMap.pipeline.name} (${state.outcomeMap.pipeline.stageCount} stages)` : 'none — follow one in Setup → Pipelines before logging'}.
            </p>
          </section>

          {/* Failed logs */}
          <section className="space-y-2">
            <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Failed logs {state.failedLogs.length ? <Badge variant="danger" size="xs">{state.failedLogs.length}</Badge> : null}
            </h4>
            {state.failedLogs.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                None. A log whose GoHighLevel steps did not all succeed stays red on the technician&apos;s My day and is listed here until it is retried or undone.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {state.failedLogs.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-[8px] text-[12px]" style={{ background: 'var(--negative-muted, var(--danger-muted))', border: '1px solid var(--negative-border, var(--danger-border))' }}>
                    <Badge variant="danger" size="xs">{f.state}</Badge>
                    <span className="font-medium">{f.clientName}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>{f.label} · {f.userName} · {fmtWhen(f.createdAt)}</span>
                    <span className="basis-full" style={{ color: 'var(--danger)' }}>
                      {f.failedStep ? `${f.failedStep}: ` : ''}
                      {f.error}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <Modal
        isOpen={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Turn dry run off?"
        description="Outcomes logged from now on will move stages, set appointment statuses and add notes in GoHighLevel — and GoHighLevel may message the client on a stage move."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Keep dry run
            </Button>
            <Button
              variant="danger"
              loading={busy === 'Dry run'}
              onClick={async () => {
                await patch({ dryRun: false, confirm: true }, 'Dry run');
                setConfirmOff(false);
              }}
            >
              Send to GoHighLevel
            </Button>
          </>
        }
        size="sm"
      >
        <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          {state?.writeKey.configured ? `The write key ${state.writeKey.preview} will be used.` : 'There is no write key yet — logs will be refused until one is saved.'}
        </p>
      </Modal>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
