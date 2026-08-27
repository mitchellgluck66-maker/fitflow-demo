'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Megaphone, CheckCircle2, XCircle, Eye, EyeOff, Trash2, RefreshCw, History } from 'lucide-react';
import { Card, CardHeader, Badge, Button, Input, Toast } from '@/components';

interface MetaCreds {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  tokenPreview: string | null;
  adAccountId: string | null;
  hasToken: boolean;
  hasAdAccountId: boolean;
  lastSync: { kind: string; status: string; startedAt: string; stats: Record<string, number>; error: string | null; requestsUsed: number } | null;
}

/**
 * Meta Ads credential card. Same shape as the GoHighLevel card: paste, save,
 * verify with one request, masked thereafter. Renders a clean "Not connected"
 * state until a token exists — the rest of the app already knows how to
 * light up when Meta rows start arriving.
 */
export const MetaCard: React.FC = () => {
  const [creds, setCreds] = useState<MetaCreds | null>(null);
  const [verified, setVerified] = useState<{ ok: boolean; message: string } | null>(null);
  const [token, setToken] = useState('');
  const [adAccountId, setAdAccountId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    try {
      const data: MetaCreds = await fetch('/api/meta/credentials').then((r) => r.json());
      setCreds(data);
      setAdAccountId(data.adAccountId ?? '');
    } catch {
      setToast({ message: 'Could not load Meta state', type: 'error' });
    }
  }, []);

  useEffect(() => {
    fetch('/api/meta/credentials')
      .then((r) => r.json())
      .then((data: MetaCreds) => {
        setCreds(data);
        setAdAccountId(data.adAccountId ?? '');
      })
      .catch(() => setToast({ message: 'Could not load Meta state', type: 'error' }));
  }, []);

  const save = async () => {
    setBusy('save');
    try {
      const data = await fetch('/api/meta/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token || undefined, adAccountId }),
      }).then((r) => r.json());
      setVerified({ ok: Boolean(data.ok), message: data.verification?.message ?? data.error ?? '' });
      setToast({ message: data.ok ? 'Meta connected' : 'Could not verify', detail: data.verification?.message ?? data.error, type: data.ok ? 'success' : 'error' });
      setToken('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('save');
    try {
      const data = await fetch('/api/meta/credentials', { method: 'DELETE' }).then((r) => r.json());
      setVerified(null);
      setToast({ message: data.message, type: 'info' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const sync = async (mode: 'delta' | 'backfill') => {
    setBusy(mode);
    try {
      const data = await fetch('/api/meta/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then((r) => r.json());
      setToast({ message: data.ok ? 'Meta sync complete' : 'Meta sync failed', detail: data.message ?? data.error, type: data.ok ? 'success' : 'error' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const configured = Boolean(creds?.configured);
  const connected = configured && verified?.ok === true;
  const last = creds?.lastSync;

  return (
    <Card padding="lg">
      <CardHeader
        title="Meta Ads"
        subtitle="Marketing API insights — spend, impressions, clicks and leads per ad per day. Read-only."
        icon={Megaphone}
        action={
          <Badge variant={connected ? 'success' : configured ? 'warning' : 'neutral'} dot>
            {connected ? 'Connected' : configured ? 'Saved' : 'Not connected'}
          </Badge>
        }
      />

      {configured ? (
        <div
          className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-[8px] mb-4"
          style={{
            background: verified?.ok === false ? 'var(--warning-muted)' : 'var(--success-muted)',
            border: `1px solid ${verified?.ok === false ? 'var(--warning-border)' : 'var(--success-border)'}`,
          }}
        >
          {verified?.ok === false ? (
            <XCircle size={14} strokeWidth={2.3} style={{ color: 'var(--warning)' }} />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2.3} style={{ color: 'var(--success)' }} />
          )}
          <span className="text-[12.5px]" style={{ color: verified?.ok === false ? 'var(--warning)' : 'var(--success)' }}>
            Token <strong>{creds?.tokenPreview}</strong> for account <strong>{creds?.adAccountId}</strong>
            {verified?.message ? ` — ${verified.message}` : ''}
          </span>
          <Badge variant="neutral" size="xs">
            from {creds?.source === 'settings' ? 'app settings' : 'env vars'}
          </Badge>
        </div>
      ) : (
        <p className="text-[12.5px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
          Paste a long-lived access token and the ad account id. FitFlow only reads insights. Until then, weekly spend
          entered on the Ads tab powers cost per client.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Access token (long-lived)
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={creds?.hasToken ? 'Saved — paste a new token to replace' : 'EAAG…'}
              autoComplete="off"
              spellCheck={false}
              className="w-full h-8 pl-2.5 pr-9 text-[13px] rounded-[7px]"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? 'Hide token' : 'Show token'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-[5px] transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-quaternary)' }}
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>

        <Input
          label="Ad account id"
          value={adAccountId}
          onChange={(e) => setAdAccountId(e.target.value)}
          placeholder="act_1234567890 or 1234567890"
          hint="Meta Ads Manager → Account overview. With or without the act_ prefix."
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={busy === 'save'} disabled={!adAccountId || (!token && !creds?.hasToken)} onClick={save}>
            Save &amp; verify
          </Button>
          {creds?.source === 'settings' && (
            <Button variant="ghost" icon={Trash2} onClick={forget}>
              Forget token
            </Button>
          )}
          <div className="flex-1" />
          <Button icon={RefreshCw} loading={busy === 'delta'} disabled={!configured} onClick={() => sync('delta')}>
            Sync now
          </Button>
          <Button icon={History} loading={busy === 'backfill'} disabled={!configured} onClick={() => sync('backfill')}>
            Backfill
          </Button>
        </div>

        {last && (
          <div className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
            Last run: <strong>{last.kind}</strong> ·{' '}
            <Badge variant={last.status === 'succeeded' ? 'success' : last.status === 'failed' ? 'danger' : 'warning'} size="xs">
              {last.status}
            </Badge>{' '}
            · {new Date(last.startedAt).toLocaleString()} · {last.requestsUsed} requests
            {last.error && <span style={{ color: 'var(--danger)' }}> · {last.error}</span>}
          </div>
        )}
      </div>

      <Toast
        isVisible={toast !== null}
        message={toast?.message ?? ''}
        detail={toast?.detail}
        type={toast?.type ?? 'info'}
        onClose={() => setToast(null)}
      />
    </Card>
  );
};
