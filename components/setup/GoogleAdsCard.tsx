'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Eye, EyeOff, RefreshCw, History, Trash2 } from 'lucide-react';
import { Card, CardHeader, Button, Badge, Toast, Input } from '@/components';

interface State {
  configured: boolean;
  pending: boolean;
  source: string;
  present: Record<string, boolean>;
  developerTokenPreview: string | null;
  clientId: string | null;
  clientSecretPreview: string | null;
  refreshTokenPreview: string | null;
  customerId: string | null;
  loginCustomerId: string | null;
  lastSync: { kind: string; status: string; startedAt: string; error: string | null; stats: Record<string, number> } | null;
}

type SecretField = 'developerToken' | 'clientSecret' | 'refreshToken';

export const GoogleAdsCard: React.FC = () => {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState({ developerToken: '', clientId: '', clientSecret: '', refreshToken: '', customerId: '', loginCustomerId: '' });
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/googleads/credentials');
    const data: State = await res.json();
    setState(data);
    setForm((f) => ({ ...f, clientId: data.clientId ?? '', customerId: data.customerId ?? '', loginCustomerId: data.loginCustomerId ?? '' }));
  }, []);

  useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body.
    const id = setTimeout(() => {
      void load().catch(() => setToast({ message: 'Could not load Google Ads state', type: 'error' }));
    }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const save = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/googleads/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      setToast({ message: data.ok ? 'Connected' : data.verification?.pending ? 'Saved — pending Google' : 'Saved', detail: data.verification?.message ?? data.error, type: data.ok ? 'success' : 'info' });
      setForm((f) => ({ ...f, developerToken: '', clientSecret: '', refreshToken: '' }));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/googleads/credentials', { method: 'DELETE' });
      const data = await res.json();
      setToast({ message: data.message ?? 'Cleared', type: 'info' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const sync = async (mode: 'delta' | 'backfill') => {
    setBusy(mode);
    try {
      const res = await fetch('/api/googleads/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      const data = await res.json();
      setToast({ message: data.ok ? 'Google Ads synced' : 'Sync failed', detail: data.message ?? data.error, type: data.ok ? 'success' : 'error' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const status = !state ? 'neutral' : state.configured ? 'success' : state.pending ? 'warning' : 'neutral';
  const statusLabel = !state ? '…' : state.configured ? 'Connected' : state.pending ? 'Pending Google' : 'Not connected';

  const secretInput = (field: SecretField, label: string, preview: string | null) => (
    <div>
      <label className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}
        {preview && (
          <span className="ml-2 text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
            saved {preview}
          </span>
        )}
      </label>
      <div className="relative">
        <input
          type={show[field] ? 'text' : 'password'}
          value={form[field]}
          onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
          placeholder={preview ? 'Saved — paste to replace' : ''}
          autoComplete="off"
          spellCheck={false}
          className="w-full h-8 pl-2.5 pr-9 text-[13px] rounded-[7px]"
          style={{ fontFamily: 'var(--font-jetbrains)' }}
        />
        <button
          type="button"
          onClick={() => setShow((s) => ({ ...s, [field]: !s[field] }))}
          aria-label={show[field] ? 'Hide' : 'Show'}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-[5px] hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--text-quaternary)' }}
        >
          {show[field] ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    </div>
  );

  return (
    <Card padding="lg">
      <CardHeader
        title="Google Ads"
        subtitle="Developer token + OAuth client — granted by Google after the token is approved"
        icon={BarChart3}
        action={
          <Badge variant={status} dot>
            {statusLabel}
          </Badge>
        }
      />

      <div
        className="px-3 py-2.5 rounded-[8px] mb-4 text-[12.5px]"
        style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        {state?.configured
          ? 'Connected. Campaign spend syncs daily via the dispatcher and replaces manual weekly entries for the dates it covers.'
          : 'OAuth access is granted by Google after the developer token is approved. Fill in what you have — partial saves are kept — and until then upload the Google Ads CSV export on the Ads tab.'}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {secretInput('developerToken', 'Developer token', state?.developerTokenPreview ?? null)}
        <Input label="Customer ID" value={form.customerId} onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))} placeholder="123-456-7890" hint="The ad account, dashes optional" />
        <Input label="OAuth client ID" value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} placeholder="….apps.googleusercontent.com" />
        {secretInput('clientSecret', 'OAuth client secret', state?.clientSecretPreview ?? null)}
        {secretInput('refreshToken', 'OAuth refresh token', state?.refreshTokenPreview ?? null)}
        <Input label="Login customer ID (MCC, optional)" value={form.loginCustomerId} onChange={(e) => setForm((f) => ({ ...f, loginCustomerId: e.target.value }))} placeholder="manager account id" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Button variant="primary" loading={busy === 'save'} onClick={save}>
          {state?.configured ? 'Save & verify' : 'Save'}
        </Button>
        <Button icon={RefreshCw} loading={busy === 'delta'} disabled={!state?.configured} onClick={() => sync('delta')}>
          Sync now
        </Button>
        <Button icon={History} loading={busy === 'backfill'} disabled={!state?.configured} onClick={() => sync('backfill')}>
          Backfill
        </Button>
        {state?.source === 'settings' && (
          <Button variant="ghost" icon={Trash2} onClick={forget}>
            Forget
          </Button>
        )}
      </div>

      {state?.lastSync && (
        <p className="text-[11.5px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
          Last run: {state.lastSync.kind} · {state.lastSync.status} · {new Date(state.lastSync.startedAt).toLocaleString()}
          {state.lastSync.error ? ` · ${state.lastSync.error}` : ''}
        </p>
      )}

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </Card>
  );
};
