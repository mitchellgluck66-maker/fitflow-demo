'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  Trash2,
  GitBranch,
  RefreshCw,
  FlaskConical,
  Database,
  Eye,
  EyeOff,
  ShieldCheck,
  History,
  AlertTriangle,
  Activity,
  DollarSign,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Badge,
  Toast,
  Input,
  Toggle,
  Select,
  PageHeader,
  PageBody,
  PageLoader,
} from '@/components';
import { SpendEntry } from '@/components/SpendEntry';

interface Credentials {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  tokenPreview: string | null;
  locationId: string | null;
  hasToken: boolean;
  hasLocationId: boolean;
  requiredScopes: string[];
}

interface StageRow {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  semanticRole: string | null;
  roleSource: string;
  roleConfidence: number | null;
  suggestedRole: string | null;
  archived: boolean;
  origin: string;
}

interface PipelineRow {
  id: string;
  name: string;
  isTracked: boolean;
  archived: boolean;
  origin: string;
  syncedAt: string;
  stages: StageRow[];
}

interface Incident {
  id: string;
  kind: string;
  severity: string;
  message: string;
  createdAt: string;
}

interface PipelinesData {
  pipelines: PipelineRow[];
  unmapped: StageRow[];
  roles: Array<{ value: string; label: string }>;
  incidents: Incident[];
}

interface SyncRun {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  requestsUsed: number;
  stats: Record<string, number>;
  warnings: string[];
  error: string | null;
}

interface SyncData {
  connection: { ok: boolean; configured: boolean; message: string; pipelineCount?: number };
  lastSyncAt: string | null;
  runs: SyncRun[];
  incidents: Incident[];
}

interface Provenance {
  demoContacts: number;
  ghlContacts: number;
  demoAppointments: number;
  ghlAppointments: number;
  hasDemoData: boolean;
  hasRealData: boolean;
  backfillFrom: string | null;
}

const ROLE_VARIANT: Record<string, 'info' | 'accent' | 'warning' | 'danger' | 'success' | 'neutral'> = {
  applied: 'info',
  consult_booked: 'accent',
  consult_noshow: 'warning',
  roadmap_booked: 'accent',
  roadmap_showed: 'accent',
  enrolled: 'success',
  other: 'neutral',
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function SetupPage() {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [pipelines, setPipelines] = useState<PipelinesData | null>(null);
  const [sync, setSync] = useState<SyncData | null>(null);
  const [prov, setProv] = useState<Provenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [backfillFrom, setBackfillFrom] = useState('2026-06-16');

  const loadAll = useCallback(async () => {
    try {
      const [c, p, s, pv] = await Promise.all([
        fetch('/api/ghl/credentials').then((r) => r.json()),
        fetch('/api/ghl/pipelines').then((r) => r.json()),
        fetch('/api/sync').then((r) => r.json()),
        fetch('/api/ghl/backfill').then((r) => r.json()),
      ]);
      setCreds(c);
      setLocationId(c.locationId ?? '');
      setPipelines(p);
      setSync(s);
      setProv(pv);
      if (pv?.backfillFrom) setBackfillFrom(pv.backfillFrom);
    } catch {
      setToast({ message: 'Could not load setup state', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveCreds = async () => {
    setBusy('creds');
    try {
      const res = await fetch('/api/ghl/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token || undefined, locationId }),
      });
      const data = await res.json();
      setToast({
        message: data.ok ? 'Connected' : 'Could not verify',
        detail: data.verification?.message ?? data.error,
        type: data.ok ? 'success' : 'error',
      });
      setToken('');
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const clearCreds = async () => {
    setBusy('creds');
    try {
      const res = await fetch('/api/ghl/credentials', { method: 'DELETE' });
      const data = await res.json();
      setToast({ message: data.message, type: 'info' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const runSync = async () => {
    setBusy('sync');
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      setToast({
        message: data.ok ? 'Sync complete' : 'Sync failed',
        detail: data.message ?? data.error,
        type: data.ok ? 'success' : 'error',
      });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const runBackfill = async () => {
    setBusy('backfill');
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backfillFrom }),
      });
      const res = await fetch('/api/ghl/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: backfillFrom }),
      });
      const data = await res.json();
      setToast({
        message: data.ok ? 'Backfill complete' : 'Backfill failed',
        detail: data.message ?? data.error,
        type: data.ok ? 'success' : 'error',
      });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const setRole = async (stageId: string, semanticRole: string) => {
    setBusy(`role:${stageId}`);
    try {
      const res = await fetch('/api/ghl/pipelines', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId, semanticRole }),
      });
      const data = await res.json();
      if (!data.ok) setToast({ message: 'Could not save role', detail: data.error, type: 'error' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const setTracked = async (pipelineId: string, isTracked: boolean) => {
    setBusy(`track:${pipelineId}`);
    try {
      await fetch('/api/ghl/pipelines', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineId, isTracked }),
      });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const resetDemo = async () => {
    setBusy('reset');
    try {
      const res = await fetch('/api/ghl/reset', { method: 'POST' });
      const data = await res.json();
      setToast({ message: data.message, type: data.ok ? 'success' : 'error' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Setup" description="Connect FitFlow to GoHighLevel (read-only)" />
        <PageBody>
          <PageLoader label="Checking connection" />
        </PageBody>
      </>
    );
  }

  const connected = Boolean(creds?.configured && sync?.connection.ok);
  const unmapped = pipelines?.unmapped ?? [];
  const incidents = sync?.incidents ?? [];
  const lastRun = sync?.runs[0];

  const stepBadge = (done: boolean, label?: string) => (
    <Badge variant={done ? 'success' : 'neutral'} dot>
      {label ?? (done ? 'Done' : 'Pending')}
    </Badge>
  );

  return (
    <>
      <PageHeader
        title="Setup"
        description="Connect the read-only GoHighLevel integration, confirm how Miranda's stages map to the funnel, and watch sync health."
        actions={
          <Button icon={RefreshCw} loading={busy === 'creds'} onClick={loadAll}>
            Re-check
          </Button>
        }
      />

      <PageBody className="max-w-4xl space-y-4">
        {/* ---- Read-only guarantee ---- */}
        <div
          className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px]"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
        >
          <ShieldCheck size={15} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--success)' }} />
          <p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>FitFlow never writes to GoHighLevel.</strong> The
            token only needs read scopes; every request this app makes is a GET. Miranda&apos;s pipeline stays the
            source of truth.
          </p>
        </div>

        {/* ---- STEP 1: Credentials ---- */}
        <Card padding="lg">
          <CardHeader
            title="1 · Private Integration Token"
            subtitle="Created per sub-account in GoHighLevel → Settings → Private Integrations"
            icon={KeyRound}
            action={stepBadge(Boolean(creds?.configured), connected ? 'Connected' : creds?.configured ? 'Saved' : 'Pending')}
          />

          {creds?.configured && (
            <div
              className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-[8px] mb-4"
              style={{
                background: connected ? 'var(--success-muted)' : 'var(--warning-muted)',
                border: `1px solid ${connected ? 'var(--success-border)' : 'var(--warning-border)'}`,
              }}
            >
              {connected ? (
                <CheckCircle2 size={14} strokeWidth={2.3} style={{ color: 'var(--success)' }} />
              ) : (
                <XCircle size={14} strokeWidth={2.3} style={{ color: 'var(--warning)' }} />
              )}
              <span className="text-[12.5px]" style={{ color: connected ? 'var(--success)' : 'var(--warning)' }}>
                Token <strong>{creds.tokenPreview}</strong> for location <strong>{creds.locationId}</strong>
                {sync?.connection.message ? ` — ${sync.connection.message}` : ''}
              </span>
              <Badge variant="neutral" size="xs">
                from {creds.source === 'settings' ? 'app settings' : 'env vars'}
              </Badge>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-[12.5px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Private Integration Token
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={creds?.hasToken ? 'Saved — paste a new token to replace' : 'pit-...'}
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
              label="Location ID (sub-account)"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              placeholder="e.g. ve9EPM428h8vShlRW1KT"
              hint="GoHighLevel → Settings → Business Profile. Also visible in the URL when the sub-account is open."
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                loading={busy === 'creds'}
                disabled={!locationId || (!token && !creds?.hasToken)}
                onClick={saveCreds}
              >
                Save &amp; verify
              </Button>
              {creds?.source === 'settings' && (
                <Button variant="ghost" icon={Trash2} onClick={clearCreds}>
                  Forget token
                </Button>
              )}
            </div>

            <details className="group">
              <summary className="text-[12px] cursor-pointer select-none" style={{ color: 'var(--accent)' }}>
                Required scopes (read-only)
              </summary>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {creds?.requiredScopes.map((scope) => (
                  <code
                    key={scope}
                    className="px-1.5 py-0.5 rounded text-[11px]"
                    style={{
                      background: 'var(--surface-sunken)',
                      border: '1px solid var(--border-subtle)',
                      fontFamily: 'var(--font-jetbrains)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {scope}
                  </code>
                ))}
              </div>
            </details>
          </div>
        </Card>

        {/* ---- STEP 2: Sync + backfill ---- */}
        <Card padding="lg">
          <CardHeader
            title="2 · Sync"
            subtitle="Hourly delta sync via Vercel cron, plus a one-off history backfill"
            icon={Database}
            action={stepBadge(Boolean(prov?.hasRealData), prov?.hasRealData ? 'Real data present' : 'No real data yet')}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="px-3 py-3 rounded-[8px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[12.5px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                Delta sync
              </div>
              <p className="text-[11.5px] mb-3" style={{ color: 'var(--text-quaternary)' }}>
                Reads pipelines, stages, opportunities, contacts and the last 14 / next 90 days of appointments.
                Stage moves are derived by diffing against the previous run.
                {sync?.lastSyncAt ? ` Last: ${fmt(sync.lastSyncAt)}.` : ' Never run.'}
              </p>
              <Button icon={RefreshCw} loading={busy === 'sync'} disabled={!creds?.configured} onClick={runSync}>
                Sync now
              </Button>
            </div>

            <div className="px-3 py-3 rounded-[8px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[12.5px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                Backfill history
              </div>
              <p className="text-[11.5px] mb-2" style={{ color: 'var(--text-quaternary)' }}>
                Imports everything from this date forward, flagged <code>backfilled</code>. Safe to re-run.
              </p>
              <div className="flex items-end gap-2">
                <Input label="From" type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} />
                <Button icon={History} loading={busy === 'backfill'} disabled={!creds?.configured} onClick={runBackfill}>
                  Run backfill
                </Button>
              </div>
            </div>
          </div>

          {lastRun && (
            <div className="mt-3 text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
              Last run: <strong>{lastRun.kind}</strong> ({lastRun.trigger}) ·{' '}
              <Badge variant={lastRun.status === 'succeeded' ? 'success' : lastRun.status === 'failed' ? 'danger' : 'warning'} size="xs">
                {lastRun.status}
              </Badge>{' '}
              · {fmt(lastRun.startedAt)} · {lastRun.requestsUsed} requests
              {lastRun.error && (
                <span style={{ color: 'var(--danger)' }}> · {lastRun.error}</span>
              )}
              {Object.keys(lastRun.stats).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {Object.entries(lastRun.stats)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <Badge key={k} variant="neutral" size="xs">
                        {k} {v}
                      </Badge>
                    ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* ---- STEP 3: Stage → role mapping ---- */}
        <Card padding="lg">
          <CardHeader
            title="3 · Stage roles"
            subtitle="Stages are read live from GoHighLevel. Each needs a funnel role so renamed stages never break the numbers."
            icon={GitBranch}
            action={stepBadge(unmapped.length === 0 && (pipelines?.pipelines.length ?? 0) > 0, unmapped.length ? `${unmapped.length} unmapped` : undefined)}
          />

          {unmapped.length > 0 && (
            <div
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] mb-4"
              style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}
            >
              <AlertTriangle size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--warning)' }} />
              <p className="text-[12.5px]" style={{ color: 'var(--warning)' }}>
                {unmapped.length} stage{unmapped.length === 1 ? '' : 's'} could not be mapped confidently and{' '}
                {unmapped.length === 1 ? 'is' : 'are'} excluded from the funnel until you pick a role below. FitFlow
                never guesses.
              </p>
            </div>
          )}

          {(pipelines?.pipelines.length ?? 0) === 0 ? (
            <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
              No pipelines yet — run a sync (or <code>npm run db:seed</code> for sample data).
            </p>
          ) : (
            <div className="space-y-4">
              {pipelines!.pipelines.map((p) => (
                <div key={p.id}>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {p.name}
                    </span>
                    {p.origin === 'demo' && (
                      <Badge variant="warning" size="xs">
                        sample
                      </Badge>
                    )}
                    {p.archived && (
                      <Badge variant="neutral" size="xs">
                        archived in GHL
                      </Badge>
                    )}
                    <div className="flex-1" />
                    <Toggle
                      checked={p.isTracked}
                      onChange={(v) => setTracked(p.id, v)}
                      label="Include in funnel"
                    />
                  </div>
                  <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
                    <table className="w-full text-[12.5px]">
                      <thead>
                        <tr style={{ background: 'var(--surface-sunken)' }}>
                          {['#', 'GHL stage', 'Funnel role', 'How', 'Confidence'].map((h) => (
                            <th
                              key={h}
                              className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                              style={{ color: 'var(--text-quaternary)' }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {p.stages
                          .filter((s) => !s.archived)
                          .map((s) => (
                            <tr key={s.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                              <td className="px-3 py-2 tabular" style={{ color: 'var(--text-quaternary)' }}>
                                {s.position + 1}
                              </td>
                              <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                                {s.name}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <Select
                                    value={s.semanticRole ?? ''}
                                    onChange={(e) => e.target.value && setRole(s.id, e.target.value)}
                                  >
                                    <option value="">— choose role —</option>
                                    {pipelines!.roles.map((r) => (
                                      <option key={r.value} value={r.value}>
                                        {r.label}
                                      </option>
                                    ))}
                                  </Select>
                                  {s.semanticRole && (
                                    <Badge variant={ROLE_VARIANT[s.semanticRole] ?? 'neutral'} size="xs">
                                      {s.semanticRole}
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <Badge
                                  variant={s.roleSource === 'manual' ? 'accent' : s.roleSource === 'auto' ? 'success' : 'warning'}
                                  size="xs"
                                >
                                  {s.roleSource}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 tabular" style={{ color: 'var(--text-tertiary)' }}>
                                {s.roleConfidence != null ? `${Math.round(s.roleConfidence * 100)}%` : '—'}
                                {!s.semanticRole && s.suggestedRole && (
                                  <span className="ml-1.5" style={{ color: 'var(--text-quaternary)' }}>
                                    (suggests {s.suggestedRole})
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ---- Ad spend (manual) ---- */}
        <div id="spend">
          <Card padding="lg">
            <CardHeader
              title="Ad spend (manual, weekly)"
              subtitle="Sun–Sat weeks, in dollars. Replaced by real Meta/Google spend in Phase C."
              icon={DollarSign}
            />
            <SpendEntry />
          </Card>
        </div>

        {/* ---- Sync health ---- */}
        <Card padding="lg">
          <CardHeader
            title="Sync health"
            subtitle="Recent runs and anything that needs a human"
            icon={Activity}
            action={
              <Badge variant={incidents.length ? 'warning' : 'success'} dot>
                {incidents.length ? `${incidents.length} open` : 'All clear'}
              </Badge>
            }
          />

          {incidents.length > 0 && (
            <ul className="space-y-1.5 mb-4">
              {incidents.map((i) => (
                <li
                  key={i.id}
                  className="flex items-start gap-2 px-3 py-2 rounded-[8px] text-[12.5px]"
                  style={{
                    background: i.severity === 'critical' ? 'var(--danger-muted)' : 'var(--warning-muted)',
                    border: `1px solid ${i.severity === 'critical' ? 'var(--danger-border)' : 'var(--warning-border)'}`,
                    color: i.severity === 'critical' ? 'var(--danger)' : 'var(--warning)',
                  }}
                >
                  <Badge variant="neutral" size="xs">
                    {i.kind}
                  </Badge>
                  <span className="flex-1">{i.message}</span>
                  <span className="text-[11px] opacity-70 whitespace-nowrap">{fmt(i.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}

          {(sync?.runs.length ?? 0) === 0 ? (
            <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
              No sync runs recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    {['When', 'Kind', 'Trigger', 'Status', 'Requests', 'Result'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--text-quaternary)' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sync!.runs.slice(0, 10).map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                        {fmt(r.startedAt)}
                      </td>
                      <td className="px-3 py-2">{r.kind}</td>
                      <td className="px-3 py-2">{r.trigger}</td>
                      <td className="px-3 py-2">
                        <Badge variant={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'} size="xs">
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 tabular">{r.requestsUsed}</td>
                      <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>
                        {r.error ??
                          (Object.entries(r.stats)
                            .filter(([, v]) => v)
                            .map(([k, v]) => `${k} ${v}`)
                            .join(' · ') ||
                            '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ---- Sample data ---- */}
        <Card padding="lg">
          <CardHeader
            title="Sample data"
            subtitle="Fabricated rows are labelled origin=demo and shown with a banner until removed"
            icon={FlaskConical}
            action={
              <Badge variant={prov?.hasDemoData ? 'warning' : 'success'} dot>
                {prov?.hasDemoData ? `${prov.demoContacts} demo contacts` : 'Clean'}
              </Badge>
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[12.5px] flex-1 min-w-[240px]" style={{ color: 'var(--text-tertiary)' }}>
              {prov?.hasDemoData
                ? `${prov.demoContacts} contacts and ${prov.demoAppointments} appointments are sample data${prov.hasRealData ? ', mixed with real rows' : ''}. Remove them once the real backfill has run.`
                : 'No sample data in the database.'}
            </p>
            <Button variant="danger" icon={Trash2} loading={busy === 'reset'} disabled={!prov?.hasDemoData} onClick={resetDemo}>
              Remove sample data
            </Button>
          </div>
        </Card>
      </PageBody>

      <Toast
        isVisible={toast !== null}
        message={toast?.message ?? ''}
        detail={toast?.detail}
        type={toast?.type ?? 'info'}
        onClose={() => setToast(null)}
      />
    </>
  );
}
