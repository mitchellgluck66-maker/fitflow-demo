'use client';

import React, { useEffect, useState } from 'react';
import { Button, Input, Select, Toast, Toggle } from '@/components';
import { FetchError } from '@/components/FetchError';
import { fetchJson } from '@/lib/clientFetch';

interface SettingsState {
  hasRow: boolean;
  user: { id: string; name: string; email: string | null; role: string; ghlUserId: string | null };
  preferences: { calendarIds: string[] | null; timezone: string | null; autoAdvance: boolean };
  businessTimezone: string | null;
  timezones: string[];
  calendars: Array<{ id: string; name: string; active: boolean }>;
  calendarsSource: 'live' | 'mirror' | 'none';
  calendarsError: string | null;
}

/** /companion/settings (item 4): calendar filter, time zone, auto-advance, change password. */
export const CompanionSettings: React.FC = () => {
  const [state, setState] = useState<SettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' } | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', again: '' });

  useEffect(() => {
    let cancelled = false;
    fetchJson<SettingsState>('/api/companion/settings')
      .then((d) => {
        if (cancelled) return;
        setState(d);
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy('prefs');
    try {
      const r = await fetch('/api/companion/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; detail?: string; preferences?: SettingsState['preferences'] };
      if (r.ok && d.preferences) setState((s) => (s ? { ...s, preferences: d.preferences! } : s));
      setToast(r.ok ? { message: ok, type: 'success' } : { message: d.error ?? 'Could not save', detail: d.detail, type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.again) {
      setToast({ message: 'The new passwords do not match', type: 'error' });
      return;
    }
    setBusy('pw');
    try {
      const r = await fetch('/api/companion/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: pw.current, next: pw.next }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (r.ok) setPw({ current: '', next: '', again: '' });
      setToast(r.ok ? { message: 'Password changed', type: 'success' } : { message: d.error ?? 'Could not change the password', detail: d.detail, type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const all = state?.preferences.calendarIds === null || state?.preferences.calendarIds?.length === 0;
  const checked = (id: string) => all || Boolean(state?.preferences.calendarIds?.includes(id));
  const toggleCalendar = (id: string) => {
    if (!state) return;
    const ids = all ? state.calendars.filter((c) => c.active).map((c) => c.id) : (state.preferences.calendarIds ?? []);
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    const everything = state.calendars.filter((c) => c.active).every((c) => next.includes(c.id));
    patch({ calendarIds: everything ? null : next }, 'Calendars saved');
  };

  return (
    <div className="space-y-5 max-w-[560px]">
      <header>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-primary)' }}>
          Settings
        </h1>
        {state && (
          <p className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {state.user.name}
            {state.user.email ? ` · ${state.user.email}` : ''}
            {state.user.ghlUserId ? '' : ' · no GoHighLevel user linked'}
          </p>
        )}
      </header>

      {loadError && !state && <FetchError title="Could not load settings" error={loadError} onRetry={() => setAttempt((a) => a + 1)} />}

      {state && !state.hasRow && (
        <div role="status" className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ background: 'var(--info-muted)', border: '1px solid var(--info-border)', color: 'var(--text-primary)' }}>
          You are signed in with the team password. Sign in with a personal login to save preferences and change a password.
        </div>
      )}

      {state && (
        <>
          <section className="surface-raised rounded-[12px] p-4 space-y-3">
            <div>
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Calendars
              </h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                My day shows every call assigned to you. Untick a calendar to hide its calls. New calendars appear automatically.
              </p>
            </div>
            {state.calendarsSource === 'mirror' && (
              <p className="text-[11.5px]" style={{ color: 'var(--warning)' }}>
                Calendar names from the last sync (GoHighLevel could not be reached{state.calendarsError ? `: ${state.calendarsError}` : ''}).
              </p>
            )}
            {state.calendarsSource === 'none' && (
              <p className="text-[11.5px]" style={{ color: 'var(--warning)' }}>
                No calendars to show — GoHighLevel could not be reached{state.calendarsError ? ` (${state.calendarsError})` : ''} and this login has no synced calls yet.
              </p>
            )}
            <ul className="space-y-1.5">
              {state.calendars
                .filter((c) => c.active)
                .map((c) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-2.5 text-[13px] cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                      <input type="checkbox" checked={checked(c.id)} disabled={!state.hasRow || busy !== null} onChange={() => toggleCalendar(c.id)} className="h-4 w-4 accent-[var(--accent)]" />
                      {c.name}
                    </label>
                  </li>
                ))}
            </ul>
            {!all && (
              <Button size="xs" variant="ghost" disabled={!state.hasRow || busy !== null} onClick={() => patch({ calendarIds: null }, 'Showing every calendar')}>
                Show every calendar
              </Button>
            )}
          </section>

          <section className="surface-raised rounded-[12px] p-4 space-y-3">
            <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Time zone
            </h2>
            <Select
              label="My day's time zone"
              value={state.preferences.timezone ?? ''}
              disabled={!state.hasRow || busy !== null}
              onChange={(e) => patch({ timezone: e.target.value || null }, 'Time zone saved')}
              hint={`Business time zone: ${state.businessTimezone ?? 'not configured'}.`}
            >
              <option value="">Business time zone{state.businessTimezone ? ` (${state.businessTimezone})` : ''}</option>
              {state.timezones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </section>

          <section className="surface-raised rounded-[12px] p-4">
            <Toggle
              checked={state.preferences.autoAdvance}
              disabled={!state.hasRow || busy !== null}
              onChange={(v) => patch({ autoAdvance: v }, v ? 'The pop-out follows the clock' : 'The pop-out stays on the call you pick')}
              label="Auto-advance to the next call"
              description="The pop-out moves to the call starting within 10 minutes, then the next one, as the day goes on."
            />
          </section>

          <section className="surface-raised rounded-[12px] p-4">
            <h2 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
              Change password
            </h2>
            <form onSubmit={changePassword} className="space-y-3">
              <Input label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} disabled={!state.hasRow} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="New password" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} hint="At least 10 characters." disabled={!state.hasRow} />
                <Input label="New password again" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} disabled={!state.hasRow} />
              </div>
              <Button type="submit" variant="primary" loading={busy === 'pw'} disabled={!state.hasRow || !pw.current || !pw.next}>
                Change password
              </Button>
            </form>
          </section>
        </>
      )}

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </div>
  );
};
