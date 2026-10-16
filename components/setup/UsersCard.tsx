'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { UserCog, Plus, KeyRound, UserX, UserCheck } from 'lucide-react';
import { AccordionCard, Badge, Button, Input, Select, Toast } from '@/components';
import { fetchJson } from '@/lib/clientFetch';
import { FetchError } from '@/components/FetchError';

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'onboarding';
  ghlUserId: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
interface UsersState {
  users: PublicUser[];
  me: string;
  ghlUsers: { users: Array<{ id: string; name: string; email: string | null }>; error: string | null };
}

/** A 16-character url-safe password the owner can hand over; generated in the browser, sent once, never echoed back. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

/**
 * Setup → Users (Companion stage 1, owner only): per-person logins. Adds a user, disables / re-enables one, resets a
 * password, links the GoHighLevel user whose appointments are that person's "My day". The team password
 * (APP_PASSWORD) keeps working for owners and is not listed here.
 */
export const UsersCard: React.FC = () => {
  const [state, setState] = useState<UsersState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' } | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'onboarding' as 'owner' | 'onboarding', ghlUserId: '', password: '' });
  const [showForm, setShowForm] = useState(false);
  /** The password just set for a user, shown once so the owner can pass it on; cleared on the next action. */
  const [handed, setHanded] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(() => {
    fetchJson<UsersState>('/api/users')
      .then((d) => {
        setLoadError(null);
        setState(d);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load, attempt]);

  const ghlName = (id: string | null) => (id ? (state?.ghlUsers.users.find((u) => u.id === id)?.name ?? id) : '—');

  const call = async (key: string, url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>, ok: string): Promise<boolean> => {
    setBusy(key);
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (r.ok) {
        setToast({ message: ok, type: 'success' });
        load();
      } else setToast({ message: d.error ?? 'Could not save', detail: d.detail, type: 'error' });
      return r.ok;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const password = form.password || generatePassword();
    const ok = await call('add', '/api/users', 'POST', { ...form, ghlUserId: form.ghlUserId || null, password }, `${form.name} added`);
    if (ok) {
      setHanded({ email: form.email, password });
      setForm({ name: '', email: '', role: 'onboarding', ghlUserId: '', password: '' });
      setShowForm(false);
    }
  };

  const resetPassword = async (u: PublicUser) => {
    const password = generatePassword();
    const ok = await call(`pw:${u.id}`, `/api/users/${u.id}`, 'PATCH', { password }, `Password reset for ${u.name}`);
    if (ok) setHanded({ email: u.email, password });
  };

  const onboarding = state?.users.filter((u) => u.role === 'onboarding').length ?? 0;
  const summary = state ? `${state.users.length} user${state.users.length === 1 ? '' : 's'} · ${onboarding} onboarding` : loadError ? 'Could not load' : 'Loading…';

  return (
    <AccordionCard
      title="Users"
      summary={summary}
      subtitle="Per-person logins. Owners reach everything; an onboarding login opens only the Companion (My day + the pop-out brief). The team password still signs an owner in."
      icon={UserCog}
      defaultOpen={Boolean(loadError) || (state !== null && onboarding === 0)}
      action={state ? <Badge variant={onboarding > 0 ? 'success' : 'warning'} dot>{onboarding > 0 ? `${onboarding} onboarding` : 'No onboarding login yet'}</Badge> : undefined}
    >
      {loadError && !state && (
        <div className="mb-3">
          <FetchError compact title="Could not load users" error={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        </div>
      )}

      {handed && (
        <div role="status" className="mb-3 px-3 py-2.5 rounded-[10px] text-[12.5px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--text-primary)' }}>
          Password for <strong>{handed.email}</strong>: <code className="font-mono select-all">{handed.password}</code>
          <span className="block mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Copy it now — it is not stored anywhere readable and will not be shown again.
          </span>
          <Button size="xs" variant="ghost" className="mt-1.5" onClick={() => setHanded(null)}>
            Done
          </Button>
        </div>
      )}

      {state && state.users.length > 0 && (
        <div className="overflow-x-auto rounded-[8px] mb-3" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)', color: 'var(--text-quaternary)' }}>
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold">Email</th>
                <th className="text-left px-3 py-2 font-semibold">Role</th>
                <th className="text-left px-3 py-2 font-semibold">GHL user</th>
                <th className="text-left px-3 py-2 font-semibold">Last login</th>
                <th className="text-right px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.users.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border-subtle)', opacity: u.active ? 1 : 0.6 }}>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>
                    {u.name}
                    {!u.active && (
                      <Badge variant="danger" size="xs" className="ml-1.5">
                        disabled
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={u.role === 'owner' ? 'accent' : 'info'} size="xs">
                      {u.role}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>
                    <select
                      aria-label={`GHL user for ${u.name}`}
                      value={u.ghlUserId ?? ''}
                      disabled={busy !== null}
                      onChange={(e) => call(`ghl:${u.id}`, `/api/users/${u.id}`, 'PATCH', { ghlUserId: e.target.value || null }, `GHL user saved for ${u.name}`)}
                      className="h-7 px-1.5 text-[12px] rounded-[6px]"
                      style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', maxWidth: 220 }}
                    >
                      <option value="">— none —</option>
                      {state.ghlUsers.users.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                      {u.ghlUserId && !state.ghlUsers.users.some((g) => g.id === u.ghlUserId) && <option value={u.ghlUserId}>{ghlName(u.ghlUserId)}</option>}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 tabular" style={{ color: 'var(--text-tertiary)' }}>{fmtWhen(u.lastLoginAt)}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <Button size="xs" variant="ghost" icon={KeyRound} loading={busy === `pw:${u.id}`} disabled={busy !== null} onClick={() => resetPassword(u)}>
                      Reset password
                    </Button>
                    {u.id !== state.me && (
                      <Button
                        size="xs"
                        variant={u.active ? 'ghost' : 'secondary'}
                        icon={u.active ? UserX : UserCheck}
                        loading={busy === `act:${u.id}`}
                        disabled={busy !== null}
                        onClick={() => call(`act:${u.id}`, `/api/users/${u.id}`, 'PATCH', { active: !u.active }, u.active ? `${u.name} disabled` : `${u.name} enabled`)}
                      >
                        {u.active ? 'Disable' : 'Enable'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state && state.users.length === 0 && (
        <p className="text-[12.5px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
          No personal logins yet. Add Miranda as an onboarding user and pick her GoHighLevel user so the Companion knows which calls are hers.
        </p>
      )}
      {state?.ghlUsers.error && (
        <p className="text-[11.5px] mb-3" style={{ color: 'var(--warning)' }}>
          GoHighLevel users could not be read ({state.ghlUsers.error}) — type the GHL user id instead.
        </p>
      )}

      {!showForm ? (
        <Button variant="primary" icon={Plus} onClick={() => setShowForm(true)} disabled={!state}>
          Add user
        </Button>
      ) : (
        <div className="rounded-[10px] p-3 space-y-3" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Miranda Murphey" />
            <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="miranda@example.com" />
            <Select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'owner' | 'onboarding' })}>
              <option value="onboarding">Onboarding (Companion only)</option>
              <option value="owner">Owner (everything)</option>
            </Select>
            {state && state.ghlUsers.users.length > 0 ? (
              <Select label="GoHighLevel user" value={form.ghlUserId} onChange={(e) => setForm({ ...form, ghlUserId: e.target.value })} hint="Whose appointments are this person's day.">
                <option value="">— none —</option>
                {state.ghlUsers.users.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input label="GoHighLevel user id" value={form.ghlUserId} onChange={(e) => setForm({ ...form, ghlUserId: e.target.value })} hint="Whose appointments are this person's day." />
            )}
            <Input label="Password" type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="leave blank to generate one" hint="At least 10 characters. Shown once after saving." />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" loading={busy === 'add'} disabled={!form.name || !form.email} onClick={add}>
              Save user
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
