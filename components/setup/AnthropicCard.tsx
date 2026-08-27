'use client';

import React, { useEffect, useState } from 'react';
import { Sparkles, CheckCircle2, XCircle, Eye, EyeOff, Trash2, RefreshCw } from 'lucide-react';
import { Card, CardHeader, Badge, Button, Select, Toast } from '@/components';

interface AnthropicState {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  keyPreview: string | null;
  model: string;
  modelOptions: string[];
  defaultModel: string;
  lastGenerated: { kind: string; at: string; model: string | null } | null;
}

/**
 * Anthropic credential card — same pattern as Meta/Stripe: paste, save,
 * verify with one tiny request, masked thereafter. Powers the insight cards,
 * the Monday narrative and stage-role suggestions.
 */
export const AnthropicCard: React.FC = () => {
  const [state, setState] = useState<AnthropicState | null>(null);
  const [verified, setVerified] = useState<{ ok: boolean; message: string } | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = () =>
    fetch('/api/anthropic/credentials')
      .then((r) => r.json())
      .then((data: AnthropicState) => {
        setState(data);
        setModel(data.model);
      })
      .catch(() => setToast({ message: 'Could not load Anthropic state', type: 'error' }));

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setBusy('save');
    try {
      const data = await fetch('/api/anthropic/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey || undefined, model: model || undefined }),
      }).then((r) => r.json());
      setVerified({ ok: Boolean(data.ok), message: data.verification?.message ?? data.error ?? '' });
      setToast({ message: data.ok ? 'Anthropic connected' : 'Could not verify', detail: data.verification?.message ?? data.error, type: data.ok ? 'success' : 'error' });
      setApiKey('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('forget');
    try {
      const data = await fetch('/api/anthropic/credentials', { method: 'DELETE' }).then((r) => r.json());
      setVerified(null);
      setToast({ message: data.message ?? 'Cleared', type: 'info' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy('generate');
    try {
      const data = await fetch('/api/anthropic/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: 'this_week', compare: 'previous_period', force: true }),
      }).then((r) => r.json());
      setToast({
        message: data.notConfigured ? 'Connect Anthropic first' : data.ok ? `${data.findings?.length ?? 0} finding${data.findings?.length === 1 ? '' : 's'} generated` : 'Generation failed',
        detail: data.error,
        type: data.ok ? 'success' : 'error',
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(state?.configured && (verified ? verified.ok : true));

  return (
    <Card padding="lg">
      <CardHeader
        title="Anthropic"
        subtitle="Insight cards on the Command Center, the Monday narrative, and stage-role suggestions"
        icon={Sparkles}
        action={
          <Badge variant={!state?.configured ? 'neutral' : connected ? 'success' : 'warning'} dot>
            {!state?.configured ? 'Not connected' : verified && !verified.ok ? 'Saved · unverified' : 'Connected'}
          </Badge>
        }
      />

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
            Key <strong>{state.keyPreview}</strong> · model <strong>{state.model}</strong>
            {verified?.message ? ` — ${verified.message}` : ''}
          </span>
          <Badge variant="neutral" size="xs">
            from {state.source === 'settings' ? 'app settings' : 'env vars'}
          </Badge>
        </div>
      ) : (
        <p className="text-[12.5px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
          Paste an Anthropic API key. Insights are generated nightly from the same metrics the dashboard uses; nothing is
          sent except the numbers already on screen.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            API key
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={state?.keyPreview ? 'Saved — paste a new key to replace' : 'sk-ant-...'}
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
        </div>

        <Select label="Model" value={model} onChange={(e) => setModel(e.target.value)} hint="Sonnet is plenty for a nightly read of a small metrics snapshot.">
          {(state?.modelOptions ?? [model]).map((m) => (
            <option key={m} value={m}>
              {m}
              {m === state?.defaultModel ? ' (default)' : ''}
            </option>
          ))}
        </Select>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={busy === 'save'} disabled={!apiKey && !state?.configured} onClick={save}>
            Save &amp; verify
          </Button>
          {state?.source === 'settings' && (
            <Button variant="ghost" icon={Trash2} loading={busy === 'forget'} onClick={forget}>
              Forget key
            </Button>
          )}
          <div className="flex-1" />
          <Button icon={RefreshCw} loading={busy === 'generate'} disabled={!state?.configured} onClick={generate}>
            Generate insights now
          </Button>
        </div>

        <p className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
          {state?.lastGenerated
            ? `Last generated ${new Date(state.lastGenerated.at).toLocaleString()} · ${state.lastGenerated.model ?? ''}`
            : 'No insights generated yet.'}
        </p>
      </div>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </Card>
  );
};
