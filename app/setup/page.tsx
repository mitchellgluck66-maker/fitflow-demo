'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  Download,
  Trash2,
  CalendarDays,
  GitBranch,
  ArrowRight,
  RefreshCw,
  FlaskConical,
  Database,
  Eye,
  EyeOff,
  Radio,
  ShieldAlert,
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

interface Credentials {
  configured: boolean;
  dryRun: boolean;
  notifyOnWrite: boolean;
  source: 'settings' | 'env' | 'none';
  tokenPreview: string | null;
  locationId: string | null;
  hasToken: boolean;
  hasLocationId: boolean;
  followedCalendars: string[];
  requiredScopes: string[];
}

interface Discovery {
  ok: boolean;
  error?: string;
  calendars: Array<{ id: string; name: string; inferredType: string }>;
  pipelines: Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; name: string }>;
    stageCount: number;
  }>;
  users: Array<{ id: string; name: string }>;
  suggestedPipelineId: string | null;
  stageMapping: Array<{
    localStage: string;
    ghlStageId: string | null;
    confidence: number;
    needsReview: boolean;
  }>;
  provenance: {
    demoLeads: number;
    ghlLeads: number;
    demoAppointments: number;
    ghlAppointments: number;
    hasDemoData: boolean;
    hasRealData: boolean;
  };
}

const LOCAL_TYPES = ['Consult', 'Roadmap', 'Follow-Up', 'Check-In'];

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function SetupPage() {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [provenance, setProvenance] = useState<Discovery['provenance'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail?: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  // Credential form
  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [liveMode, setLiveMode] = useState(false);

  // Calendars / pipeline
  const [followed, setFollowed] = useState<string[]>([]);
  const [calendarMap, setCalendarMap] = useState<Record<string, string>>({});
  const [pipelineId, setPipelineId] = useState('');
  const [stageMap, setStageMap] = useState<Record<string, string>>({});

  // Import
  const [startDate, setStartDate] = useState(daysFromNow(-60));
  const [endDate, setEndDate] = useState(daysFromNow(30));
  const [clearDemo, setClearDemo] = useState(true);
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);

  const loadCreds = useCallback(async () => {
    const res = await fetch('/api/ghl/credentials');
    const data: Credentials = await res.json();
    setCreds(data);
    setLocationId(data.locationId ?? '');
    setLiveMode(!data.dryRun);
    setFollowed(data.followedCalendars ?? []);
    return data;
  }, []);

  const loadDiscovery = useCallback(async () => {
    const res = await fetch('/api/ghl/discover');
    const data: Discovery = await res.json();
    setDiscovery(data);

    if (data.ok) {
      if (data.suggestedPipelineId && !pipelineId) setPipelineId(data.suggestedPipelineId);

      const nextStages: Record<string, string> = {};
      for (const m of data.stageMapping ?? []) {
        if (m.ghlStageId) nextStages[m.localStage] = m.ghlStageId;
      }
      setStageMap((prev) => (Object.keys(prev).length ? prev : nextStages));

      setCalendarMap((prev) => {
        const next = { ...prev };
        for (const c of data.calendars ?? []) {
          if (!next[c.id]) next[c.id] = c.inferredType;
        }
        return next;
      });
    }
    return data;
  }, [pipelineId]);

  const loadProvenance = useCallback(async () => {
    const res = await fetch('/api/ghl/import');
    setProvenance(await res.json());
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const c = await loadCreds();
      await loadProvenance();
      if (c.configured) await loadDiscovery();
      else setDiscovery(null);
    } catch {
      setToast({ message: 'Could not load setup state', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [loadCreds, loadDiscovery, loadProvenance]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveCredentials = async () => {
    setBusy('creds');
    try {
      const res = await fetch('/api/ghl/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(token.trim() ? { token: token.trim() } : {}),
          locationId: locationId.trim(),
          dryRun: !liveMode,
        }),
      });
      const data = await res.json();

      setToast({
        message: data.verification?.ok ? 'Credentials saved' : 'Saved, but not working',
        detail: data.verification?.message,
        type: data.verification?.ok ? 'success' : 'error',
      });

      // Never keep the plaintext token in component state after saving.
      setToken('');
      await loadAll();
    } catch {
      setToast({ message: 'Could not save credentials', type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const clearCredentials = async () => {
    setBusy('clear-creds');
    try {
      const res = await fetch('/api/ghl/credentials', { method: 'DELETE' });
      const data = await res.json();
      setToast({ message: 'Credentials cleared', detail: data.message, type: 'info' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const saveCalendars = async () => {
    setBusy('calendars');
    try {
      await fetch('/api/ghl/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followedCalendars: followed }),
      });
      await fetch('/api/ghl/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineId, stageMap, calendarMap }),
      });
      setToast({
        message: 'Calendars saved',
        detail: `Following ${followed.length} calendar${followed.length === 1 ? '' : 's'}.`,
        type: 'success',
      });
      await loadCreds();
    } finally {
      setBusy(null);
    }
  };

  const saveMapping = async () => {
    setBusy('mapping');
    try {
      const res = await fetch('/api/ghl/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineId, stageMap, calendarMap }),
      });
      const data = await res.json();
      setToast({
        message: 'Pipeline mapping saved',
        detail: `${data.mappedStages} stages mapped.`,
        type: 'success',
      });
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy('import');
    setImportResult(null);
    try {
      const res = await fetch('/api/ghl/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarIds: followed,
          pipelineId,
          startDate,
          endDate,
          clearDemoData: clearDemo,
        }),
      });
      const data = await res.json();
      setImportResult(data);
      setToast({
        message: data.ok ? 'Import complete' : 'Import failed',
        detail: data.message ?? data.error,
        type: data.ok ? 'success' : 'error',
      });
      await loadAll();
    } catch {
      setToast({ message: 'Import failed', type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const wipeDemo = async () => {
    setBusy('reset');
    try {
      const res = await fetch('/api/ghl/reset', { method: 'POST' });
      const data = await res.json();
      setToast({ message: 'Sample data cleared', detail: data.message, type: 'success' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Setup" description="Connect FitFlow to GoHighLevel" />
        <PageBody>
          <PageLoader label="Checking connection" />
        </PageBody>
      </>
    );
  }

  const connected = creds?.configured && discovery?.ok;
  const prov = provenance ?? discovery?.provenance;
  const activePipeline = discovery?.pipelines.find((p) => p.id === pipelineId);

  const stepBadge = (done: boolean) => (
    <Badge variant={done ? 'success' : 'neutral'} dot>
      {done ? 'Done' : 'Pending'}
    </Badge>
  );

  return (
    <>
      <PageHeader
        title="Setup"
        description="Connect your GoHighLevel account, choose which calendars to follow, and import your real data."
        actions={
          <Button icon={RefreshCw} loading={busy === 'creds'} onClick={loadAll}>
            Re-check
          </Button>
        }
      />

      <PageBody className="max-w-4xl space-y-4">
        {/* ---- STEP 1: Private Integration Token ---- */}
        <Card padding="lg">
          <CardHeader
            title="1 · Private Integration Token"
            subtitle="GoHighLevel's replacement for API keys — created per sub-account"
            icon={KeyRound}
            action={stepBadge(Boolean(creds?.configured))}
          />

          {creds?.configured && (
            <div
              className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-[8px] mb-4"
              style={{
                background: 'var(--success-muted)',
                border: '1px solid var(--success-border)',
              }}
            >
              <CheckCircle2
                size={14}
                strokeWidth={2.3}
                className="shrink-0"
                style={{ color: 'var(--success)' }}
              />
              <span className="text-[12.5px]" style={{ color: 'var(--success)' }}>
                Token <strong>{creds.tokenPreview}</strong> saved for location{' '}
                <strong>{creds.locationId}</strong>
              </span>
              <Badge variant="neutral" size="xs">
                from {creds.source === 'settings' ? 'app settings' : '.env.local'}
              </Badge>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label
                className="block text-[12.5px] font-medium mb-1.5"
                style={{ color: 'var(--text-secondary)' }}
              >
                Private Integration Token
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    creds?.hasToken ? 'Saved — paste a new token to replace' : 'pit-...'
                  }
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

            <div
              className="px-3 py-2.5 rounded-[8px]"
              style={{
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <Toggle
                checked={liveMode}
                onChange={setLiveMode}
                label="Live mode"
                description="Off = every write is queued and previewed but never sent. Turn on once you've confirmed the stage mapping below is right."
              />
            </div>

            <div
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px]"
              style={{
                background: 'var(--warning-muted)',
                border: '1px solid var(--warning-border)',
              }}
            >
              <ShieldAlert
                size={14}
                strokeWidth={2.3}
                className="mt-px shrink-0"
                style={{ color: 'var(--warning)' }}
              />
              <p
                className="text-[11.5px] leading-relaxed"
                style={{ color: 'var(--warning)' }}
              >
                A token entered here is stored in the app's local database in plain text.
                That's fine for a single-user tool on your own machine. If you ever host
                this for a team, put the token in <code>.env.local</code> instead and leave
                this field blank.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={KeyRound}
                loading={busy === 'creds'}
                disabled={!locationId.trim() || (!token.trim() && !creds?.hasToken)}
                onClick={saveCredentials}
              >
                Save &amp; verify
              </Button>

              {creds?.source === 'settings' && (
                <Button
                  variant="ghost"
                  icon={Trash2}
                  loading={busy === 'clear-creds'}
                  onClick={clearCredentials}
                >
                  Forget token
                </Button>
              )}
            </div>
          </div>

          {!creds?.configured && (
            <details className="mt-4">
              <summary
                className="text-[12.5px] cursor-pointer select-none"
                style={{ color: 'var(--accent)' }}
              >
                Where do I find these?
              </summary>
              <div
                className="mt-3 px-3.5 py-3 rounded-[8px] text-[12.5px] leading-relaxed"
                style={{
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}
              >
                <ol className="list-decimal ml-4 space-y-2">
                  <li>
                    In your GoHighLevel sub-account, go to{' '}
                    <strong>Settings → Private Integrations → Create new integration</strong>.
                  </li>
                  <li>
                    Grant these scopes:
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {(creds?.requiredScopes ?? []).map((s) => (
                        <code
                          key={s}
                          className="px-1.5 py-0.5 rounded-[4px] text-[11px]"
                          style={{
                            background: 'var(--surface)',
                            border: '1px solid var(--border-subtle)',
                            fontFamily: 'var(--font-jetbrains)',
                          }}
                        >
                          {s}
                        </code>
                      ))}
                    </div>
                  </li>
                  <li>
                    Copy the token immediately — GoHighLevel shows it once and never again.
                  </li>
                  <li>
                    The Location ID is in <strong>Settings → Business Profile</strong>, or in
                    your browser URL as <code>/location/&lt;id&gt;/</code>.
                  </li>
                </ol>
              </div>
            </details>
          )}

          {creds?.configured && discovery && !discovery.ok && (
            <div
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] mt-4"
              style={{
                background: 'var(--danger-muted)',
                border: '1px solid var(--danger-border)',
              }}
            >
              <XCircle
                size={14}
                strokeWidth={2.3}
                className="mt-px shrink-0"
                style={{ color: 'var(--danger)' }}
              />
              <p
                className="text-[12.5px] leading-relaxed"
                style={{ color: 'var(--danger)' }}
              >
                {discovery.error}
              </p>
            </div>
          )}
        </Card>

        {/* ---- STEP 2: Calendars ---- */}
        {connected && (
          <Card padding="lg">
            <CardHeader
              title="2 · Calendars to follow"
              subtitle="Only appointments on these calendars appear in the Today View"
              icon={CalendarDays}
              action={stepBadge(followed.length > 0)}
            />

            {discovery.calendars.length === 0 ? (
              <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
                No calendars found in this location.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFollowed(discovery.calendars.map((c) => c.id))}
                  >
                    Select all
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setFollowed([])}>
                    Clear
                  </Button>
                  <span
                    className="text-[11.5px] tabular"
                    style={{ color: 'var(--text-quaternary)' }}
                  >
                    {followed.length} of {discovery.calendars.length} selected
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  {discovery.calendars.map((c) => {
                    const on = followed.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-[8px] cursor-pointer transition-colors"
                        style={{
                          background: on ? 'var(--accent-muted)' : 'var(--surface-sunken)',
                          border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 26%, transparent)' : 'var(--border-subtle)'}`,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setFollowed((prev) =>
                              e.target.checked
                                ? [...prev, c.id]
                                : prev.filter((id) => id !== c.id),
                            )
                          }
                          className="shrink-0"
                          style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
                        />

                        <Radio
                          size={13}
                          strokeWidth={2.2}
                          className="shrink-0"
                          style={{
                            color: on ? 'var(--accent)' : 'var(--text-quaternary)',
                          }}
                        />

                        <span
                          className="text-[12.5px] font-medium flex-1 truncate"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {c.name}
                        </span>

                        <select
                          value={calendarMap[c.id] ?? c.inferredType}
                          onChange={(e) =>
                            setCalendarMap((prev) => ({ ...prev, [c.id]: e.target.value }))
                          }
                          onClick={(e) => e.preventDefault()}
                          className="h-7 px-2 text-[12px] rounded-[6px] w-[124px]"
                        >
                          {LOCAL_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>

                <p
                  className="text-[11.5px] mt-2.5 leading-relaxed"
                  style={{ color: 'var(--text-quaternary)' }}
                >
                  GoHighLevel has no appointment-type field — an appointment's type is
                  simply which calendar it sits on. The dropdown maps each calendar to one
                  of FitFlow's four types.
                </p>

                <div className="mt-4">
                  <Button
                    variant="primary"
                    loading={busy === 'calendars'}
                    disabled={followed.length === 0}
                    onClick={saveCalendars}
                  >
                    Save calendar selection
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}

        {/* ---- STEP 3: Pipeline ---- */}
        {connected && (
          <Card padding="lg">
            <CardHeader
              title="3 · Pipeline & stages"
              subtitle="Stage IDs are unique to your account, so they're read live and stored"
              icon={GitBranch}
              action={stepBadge(Object.keys(stageMap).length > 0)}
            />

            <Select
              label="Pipeline to track"
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageMap({});
              }}
            >
              <option value="">Select a pipeline…</option>
              {discovery.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.stageCount} stages)
                </option>
              ))}
            </Select>

            {activePipeline && (
              <div className="mt-4 flex flex-col gap-1.5">
                {discovery.stageMapping.map((m) => (
                  <div
                    key={m.localStage}
                    className="flex items-center gap-3 px-3 py-2 rounded-[8px]"
                    style={{
                      background: 'var(--surface-sunken)',
                      border: `1px solid ${m.needsReview ? 'var(--warning-border)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    <span
                      className="text-[12.5px] font-medium w-[186px] shrink-0 truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {m.localStage}
                    </span>
                    <ArrowRight
                      size={12}
                      strokeWidth={2.3}
                      className="shrink-0"
                      style={{ color: 'var(--text-quaternary)' }}
                    />
                    <select
                      value={stageMap[m.localStage] ?? ''}
                      onChange={(e) =>
                        setStageMap((prev) => ({ ...prev, [m.localStage]: e.target.value }))
                      }
                      className="flex-1 h-7 px-2 text-[12.5px] rounded-[6px]"
                    >
                      <option value="">— not mapped —</option>
                      {activePipeline.stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    {m.needsReview && stageMap[m.localStage] && (
                      <Badge variant="warning" size="xs">
                        check
                      </Badge>
                    )}
                  </div>
                ))}

                <p
                  className="text-[11.5px] mt-1.5 leading-relaxed"
                  style={{ color: 'var(--text-quaternary)' }}
                >
                  Anything flagged <strong>check</strong> was matched by name similarity
                  below the confidence threshold. A wrong mapping moves real opportunities
                  to the wrong stage — confirm these before turning live mode on.
                </p>
              </div>
            )}

            <div className="mt-4">
              <Button
                variant="primary"
                loading={busy === 'mapping'}
                disabled={!pipelineId}
                onClick={saveMapping}
              >
                Save pipeline mapping
              </Button>
            </div>
          </Card>
        )}

        {/* ---- STEP 4: Import ---- */}
        {connected && (
          <Card padding="lg">
            <CardHeader
              title="4 · Import your data"
              subtitle="Reads appointments, contacts and opportunities. Writes nothing back."
              icon={Download}
              action={stepBadge(Boolean(prov?.hasRealData))}
            />

            <div className="grid grid-cols-2 gap-3 mb-4">
              <Input
                label="From"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <Input
                label="To"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <label className="flex items-start gap-2.5 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={clearDemo}
                onChange={(e) => setClearDemo(e.target.checked)}
                className="mt-0.5 shrink-0"
                style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
              />
              <span
                className="text-[12.5px] leading-relaxed"
                style={{ color: 'var(--text-secondary)' }}
              >
                Remove sample data first — recommended, so fabricated and real numbers are
                never mixed in the same chart.
              </span>
            </label>

            <Button
              variant="primary"
              icon={Download}
              loading={busy === 'import'}
              disabled={followed.length === 0 || !pipelineId}
              onClick={runImport}
            >
              Import from GoHighLevel
            </Button>

            {followed.length === 0 && (
              <p className="text-[11.5px] mt-2" style={{ color: 'var(--warning)' }}>
                Select at least one calendar in step 2 first.
              </p>
            )}

            {importResult && (
              <div
                className="mt-4 px-3.5 py-3 rounded-[8px]"
                style={{
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <p
                  className="text-[12.5px] font-semibold mb-2"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {String(importResult.message ?? '')}
                </p>

                {Boolean(importResult.counts) && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                    {Object.entries(importResult.counts as Record<string, number>).map(
                      ([key, value]) => (
                        <div key={key} className="flex items-center justify-between gap-2">
                          <span
                            className="text-[11.5px]"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                          </span>
                          <span
                            className="text-[11.5px] font-semibold tabular"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {value}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                )}

                {Array.isArray(importResult.warnings) &&
                  (importResult.warnings as string[]).length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {(importResult.warnings as string[]).map((w, i) => (
                        <li
                          key={i}
                          className="text-[11.5px] leading-relaxed flex items-start gap-1.5"
                          style={{ color: 'var(--warning)' }}
                        >
                          <span>•</span>
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                {Boolean((importResult as { ok?: boolean }).ok) && (
                  <div className="mt-3">
                    <Link href="/today">
                      <Button variant="primary" size="sm" iconRight={ArrowRight}>
                        Go to Today View
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {/* ---- Data provenance ---- */}
        {prov && (
          <Card padding="lg">
            <CardHeader
              title="What's in your database"
              subtitle="Sample data is fabricated — it exists only to demonstrate the interface"
              icon={Database}
            />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
              {[
                { label: 'Sample leads', value: prov.demoLeads, tone: 'warning' },
                { label: 'Sample appts', value: prov.demoAppointments, tone: 'warning' },
                { label: 'Real leads', value: prov.ghlLeads, tone: 'success' },
                { label: 'Real appts', value: prov.ghlAppointments, tone: 'success' },
              ].map((s) => (
                <div
                  key={s.label}
                  className="px-3 py-2.5 rounded-[8px]"
                  style={{
                    background: 'var(--surface-sunken)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div
                    className="text-[20px] font-semibold tabular leading-none"
                    style={{
                      color: s.value > 0 ? `var(--${s.tone})` : 'var(--text-quaternary)',
                    }}
                  >
                    {s.value}
                  </div>
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--text-quaternary)' }}
                  >
                    {s.label}
                  </div>
                </div>
              ))}
            </div>

            {prov.hasDemoData && (
              <div
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] mb-3"
                style={{
                  background: 'var(--warning-muted)',
                  border: '1px solid var(--warning-border)',
                }}
              >
                <FlaskConical
                  size={14}
                  strokeWidth={2.3}
                  className="mt-px shrink-0"
                  style={{ color: 'var(--warning)' }}
                />
                <p
                  className="text-[12.5px] leading-relaxed"
                  style={{ color: 'var(--warning)' }}
                >
                  Numbers on the Dashboard, Metrics and Reports pages are generated sample
                  data — not your business.
                </p>
              </div>
            )}

            <Button
              variant="outline"
              icon={Trash2}
              loading={busy === 'reset'}
              disabled={!prov.hasDemoData}
              onClick={wipeDemo}
            >
              Clear all sample data
            </Button>
          </Card>
        )}
      </PageBody>

      {toast && (
        <Toast
          message={toast.message}
          detail={toast.detail}
          type={toast.type}
          isVisible={!!toast}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
