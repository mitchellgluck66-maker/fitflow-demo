'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, XCircle, Eye, EyeOff, Trash2, RefreshCw, History, Copy } from 'lucide-react';
import { AccordionCard, Button, Badge, Toast, Input } from '@/components';

interface StripeState {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  keyPreview: string | null;
  keyKind: 'restricted' | 'full' | 'unknown' | 'none';
  hasWebhookSecret: boolean;
  webhookPreview: string | null;
  requiredPermissions: string[];
  lastRun: { kind: string; status: string; startedAt: string; requestsUsed: number; stats: Record<string, number>; error: string | null } | null;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Stripe credentials + reconcile controls. Mirrors the GHL card. */
export const StripeCard: React.FC = () => {
  const [state, setState] = useState<StripeState | null>(null);
  const [verification, setVerification] = useState<{ ok: boolean; message: string } | null>(null);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/stripe/credentials');
    const data = await res.json();
    setState(data);
  }, []);

  useEffect(() => {
    fetch('/api/stripe/credentials')
      .then((r) => r.json())
      .then((data) => {
        setState(data);
        setOrigin(window.location.origin);
      })
      .catch(() => setToast({ message: 'Could not load Stripe state', type: 'error' }));
  }, []);

  const save = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/stripe/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretKey: secretKey || undefined, webhookSecret: webhookSecret || undefined }),
      });
      const data = await res.json();
      setVerification(data.verification ?? null);
      setToast({ message: data.ok ? 'Stripe connected' : 'Could not verify', detail: data.verification?.message ?? data.error, type: data.ok ? 'success' : 'error' });
      setSecretKey('');
      setWebhookSecret('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/stripe/credentials', { method: 'DELETE' });
      const data = await res.json();
      setVerification(null);
      setToast({ message: data.message ?? 'Cleared', type: 'info' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const sync = async (mode: 'reconcile' | 'backfill') => {
    setBusy(mode);
    try {
      const res = await fetch('/api/stripe/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      const data = await res.json();
      setToast({ message: data.ok ? `Stripe ${mode} complete` : `Stripe ${mode} failed`, detail: data.message ?? data.error, type: data.ok ? 'success' : 'error' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const webhookUrl = `${origin || 'https://<your-domain>'}/api/stripe/webhook`;
  const connected = Boolean(state?.configured && (verification ? verification.ok : true));

  return (
    <AccordionCard
      title="Stripe"
      summary={!state ? 'Loading…' : state.configured ? (verification && !verification.ok ? 'Saved — verification failed' : 'Restricted key saved') : 'Not connected'}
      subtitle="Real cash collected, recurring, failed payments and refunds — read-only restricted key"
      icon={CreditCard}
      defaultOpen={Boolean(state?.configured && verification && !verification.ok)}
      action={
        <Badge variant={state?.configured ? (connected ? 'success' : 'warning') : 'neutral'} dot>
          {state?.configured ? (connected ? 'Connected' : 'Saved') : 'Not connected'}
        </Badge>
      }
    >

      {state?.configured ? (
        <div
          className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-[8px] mb-4"
          style={{
            background: connected ? 'var(--success-muted)' : 'var(--warning-muted)',
            border: `1px solid ${connected ? 'var(--success-border)' : 'var(--warning-border)'}`,
          }}
        >
          {connected ? <CheckCircle2 size={14} strokeWidth={2.3} style={{ color: 'var(--success)' }} /> : <XCircle size={14} strokeWidth={2.3} style={{ color: 'var(--warning)' }} />}
          <span className="text-[12.5px]" style={{ color: connected ? 'var(--success)' : 'var(--warning)' }}>
            Key <strong>{state.keyPreview}</strong>
            {state.keyKind === 'full' ? ' (full secret key — a restricted rk_ key is safer)' : ''}
            {state.hasWebhookSecret ? ' · webhook secret saved' : ' · no webhook secret yet'}
            {verification?.message ? ` — ${verification.message}` : ''}
          </span>
          <Badge variant="neutral" size="xs">
            from {state.source === 'settings' ? 'app settings' : 'env vars'}
          </Badge>
        </div>
      ) : (
        <p className="text-[12.5px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
          Not connected. Revenue and ROAS stay in their &ldquo;Awaiting Stripe&rdquo; state until a key is saved here — nothing is estimated.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Restricted key
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={state?.configured ? 'Saved — paste a new key to replace' : 'rk_live_…'}
              autoComplete="off"
              spellCheck={false}
              className="w-full h-8 pl-2.5 pr-9 text-[13px] rounded-[7px]"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? 'Hide key' : 'Show key'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-[5px] transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-quaternary)' }}
            >
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-quaternary)' }}>
            Restricted key (rk_…) with read access to Charges, Customers, Subscriptions, Balance. Stripe → Developers → API keys → Create restricted key.
          </p>
        </div>

        <Input
          label="Webhook signing secret (optional, for real-time updates)"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          placeholder={state?.hasWebhookSecret ? 'Saved — paste a new secret to replace' : 'whsec_…'}
          autoComplete="off"
          hint="Stripe → Developers → Webhooks → Add endpoint with the URL below; events: charge.*, invoice.paid, invoice.payment_failed, customer.subscription.*, refund.*"
        />

        <div
          className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-[8px] text-[12px]"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>Webhook URL</span>
          <code className="flex-1 min-w-[200px] truncate" style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--text-secondary)' }}>
            {webhookUrl}
          </code>
          <Button
            variant="ghost"
            icon={Copy}
            onClick={() => {
              navigator.clipboard?.writeText(webhookUrl).then(() => setToast({ message: 'Webhook URL copied', type: 'info' })).catch(() => {});
            }}
          >
            Copy
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={busy === 'save'} disabled={!secretKey && !webhookSecret && !state?.configured} onClick={save}>
            Save &amp; verify
          </Button>
          {state?.source === 'settings' && (
            <Button variant="ghost" icon={Trash2} onClick={forget}>
              Forget key
            </Button>
          )}
          <div className="flex-1" />
          <Button icon={RefreshCw} loading={busy === 'reconcile'} disabled={!state?.configured} onClick={() => sync('reconcile')}>
            Reconcile now
          </Button>
          <Button icon={History} loading={busy === 'backfill'} disabled={!state?.configured} onClick={() => sync('backfill')}>
            Backfill
          </Button>
        </div>

        {state?.lastRun && (
          <div className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
            Last run: <strong>{state.lastRun.kind}</strong> ·{' '}
            <Badge variant={state.lastRun.status === 'succeeded' ? 'success' : state.lastRun.status === 'failed' ? 'danger' : 'warning'} size="xs">
              {state.lastRun.status}
            </Badge>{' '}
            · {fmt(state.lastRun.startedAt)} · {state.lastRun.requestsUsed} requests
            {state.lastRun.error && <span style={{ color: 'var(--danger)' }}> · {state.lastRun.error}</span>}
          </div>
        )}

        <details>
          <summary className="text-[12px] cursor-pointer select-none" style={{ color: 'var(--accent)' }}>
            Required permissions (read-only)
          </summary>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(state?.requiredPermissions ?? []).map((p) => (
              <code
                key={p}
                className="px-1.5 py-0.5 rounded text-[11px]"
                style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', fontFamily: 'var(--font-jetbrains)', color: 'var(--text-secondary)' }}
              >
                {p}
              </code>
            ))}
          </div>
        </details>
      </div>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
