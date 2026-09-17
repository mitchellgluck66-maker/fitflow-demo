'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Sparkles, AlertTriangle, RefreshCw } from 'lucide-react';
import { AccordionCard, Button, Badge, Toast, Select } from '@/components';
import { UnmatchedPayments } from './UnmatchedPayments';

interface LastRun {
  kind: string;
  trigger: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  requestsUsed: number;
  rowsUpserted: number;
  rejectedRows: number;
  error: string | null;
  warnings: string[];
}
interface Source {
  key: string;
  label: string;
  configured: boolean;
  pending?: boolean;
  cadence: string;
  lastRun: LastRun | null;
}
interface Unmapped {
  id: string;
  name: string;
  pipelineName: string;
  suggestedRole: string | null;
  roleConfidence: number | null;
}
interface Incident {
  id: string;
  kind: string;
  severity: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
}
interface Health {
  sources: Source[];
  unmappedStages: Unmapped[];
  roles: Array<{ value: string; label: string }>;
  incidents: Incident[];
  recentRuns: Array<{ id: string; kind: string; trigger: string; status: string; startedAt: string; requestsUsed: number; stats: Record<string, number>; error: string | null }>;
  sentry: boolean;
}
interface Suggestion {
  role: string;
  confidence: number;
  rationale: string;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const SyncHealth: React.FC = () => {
  const [health, setHealth] = useState<Health | null>(null);
  const [anthropic, setAnthropic] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion | { error: string }>>({});
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    const [h, a] = await Promise.all([
      fetch('/api/sync-health').then((r) => r.json()),
      fetch('/api/anthropic/credentials')
        .then((r) => (r.ok ? r.json() : { configured: false }))
        .catch(() => ({ configured: false })),
    ]);
    setHealth(h);
    setAnthropic(Boolean(a?.configured));
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void load().catch(() => setToast({ message: 'Could not load sync health', type: 'error' }));
    }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const assign = async (stageId: string, role: string) => {
    if (!role) return;
    setBusy(`assign:${stageId}`);
    try {
      const res = await fetch('/api/ghl/pipelines', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stageId, semanticRole: role }) });
      const data = await res.json();
      setToast({ message: data.ok ? 'Role assigned' : 'Could not assign', detail: data.error, type: data.ok ? 'success' : 'error' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const suggest = async (stageId: string) => {
    setBusy(`suggest:${stageId}`);
    try {
      const res = await fetch('/api/anthropic/suggest-role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stageId }) });
      const data = await res.json();
      if (res.ok && data.role) setSuggestions((s) => ({ ...s, [stageId]: { role: data.role, confidence: data.confidence ?? 0, rationale: data.rationale ?? '' } }));
      else setSuggestions((s) => ({ ...s, [stageId]: { error: data.error ?? data.message ?? 'No suggestion' } }));
    } catch (err) {
      setSuggestions((s) => ({ ...s, [stageId]: { error: String(err) } }));
    } finally {
      setBusy(null);
    }
  };

  if (!health) {
    return (
      <AccordionCard title="Sync health" summary="Loading…" icon={Activity}>
        <span />
      </AccordionCard>
    );
  }

  const needsHuman = health.unmappedStages.length;
  const lastRunAt = health.recentRuns[0]?.startedAt ?? null;
  const summary = [
    lastRunAt ? `Last sync ${ago(lastRunAt)}` : 'No runs yet',
    needsHuman ? `${needsHuman} unmapped stage${needsHuman === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <AccordionCard
      title="Sync health"
      summary={summary}
      subtitle="Every source and everything that needs a human. Incidents have their own log below."
      icon={Activity}
      defaultOpen={needsHuman > 0}
      action={
        <div className="flex items-center gap-2">
          {health.sentry && (
            <Badge variant="neutral" size="xs">
              Sentry on
            </Badge>
          )}
          <Badge variant={needsHuman ? 'warning' : 'success'} dot>
            {needsHuman ? `${needsHuman} need attention` : 'All clear'}
          </Badge>
          <Button variant="ghost" icon={RefreshCw} onClick={() => load()} />
        </div>
      }
    >

      {/* ---- Per-source status ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-5">
        {health.sources.map((s) => {
          const r = s.lastRun;
          const tone = !s.configured ? 'neutral' : !r ? 'warning' : r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : r.status === 'partial' ? 'info' : 'warning';
          return (
            <div key={s.key} className="px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {s.label}
                </span>
                <Badge variant={tone} size="xs" dot>
                  {!s.configured ? (s.pending ? 'Pending' : 'Not connected') : r ? r.status : 'No run yet'}
                </Badge>
              </div>
              <div className="text-[11.5px] space-y-0.5" style={{ color: 'var(--text-tertiary)' }}>
                <div>Cadence: {s.cadence}</div>
                {r ? (
                  <>
                    <div title={fmt(r.startedAt)}>
                      Last: {ago(r.startedAt)} · {r.kind.replace(/_/g, ' ')} ({r.trigger})
                    </div>
                    <div>
                      {r.rowsUpserted} rows · {r.requestsUsed} req{r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)}s` : ''}
                    </div>
                    {r.rejectedRows > 0 && <div style={{ color: 'var(--negative, var(--danger))' }}>{r.rejectedRows} rows rejected by validation</div>}
                    {r.error && (
                      <div style={{ color: 'var(--negative, var(--danger))' }} className="truncate" title={r.error}>
                        {r.error}
                      </div>
                    )}
                  </>
                ) : (
                  <div>{s.configured ? 'Waiting for the first run.' : 'Connect it above to start syncing.'}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Unmapped stages ---- */}
      {health.unmappedStages.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Unmapped stages ({health.unmappedStages.length})
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              excluded from the funnel until assigned — never guessed
            </span>
          </div>
          <ul className="space-y-2">
            {health.unmappedStages.map((u) => {
              const sug = suggestions[u.id];
              const pick = picks[u.id] ?? (sug && 'role' in sug ? sug.role : '');
              return (
                <li key={u.id} className="px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {u.name}
                    </span>
                    <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                      in {u.pipelineName}
                      {u.suggestedRole && u.roleConfidence != null ? ` · mapper suggests ${u.suggestedRole} (${Math.round(u.roleConfidence * 100)}%)` : ''}
                    </span>
                    <div className="flex-1" />
                    <Select value={pick} onChange={(e) => setPicks((p) => ({ ...p, [u.id]: e.target.value }))}>
                      <option value="">— choose role —</option>
                      {health.roles.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                    <Button variant="primary" loading={busy === `assign:${u.id}`} disabled={!pick} onClick={() => assign(u.id, pick)}>
                      Assign
                    </Button>
                    {anthropic && (
                      <Button icon={Sparkles} loading={busy === `suggest:${u.id}`} onClick={() => suggest(u.id)}>
                        Suggest with Claude
                      </Button>
                    )}
                  </div>
                  {sug && (
                    <div className="mt-2 text-[12px] flex flex-wrap items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                      {'role' in sug ? (
                        <>
                          <Badge variant="accent" size="xs">
                            Claude: {sug.role} · {Math.round(sug.confidence * 100)}%
                          </Badge>
                          <span className="flex-1 min-w-[200px]">{sug.rationale}</span>
                          <Button variant="primary" loading={busy === `assign:${u.id}`} onClick={() => assign(u.id, sug.role)}>
                            Apply
                          </Button>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>{sug.error}</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ---- Unmatched payments ---- */}
      <UnmatchedPayments />

      {/* ---- Recent runs ---- */}
      <details>
        <summary className="text-[12px] cursor-pointer select-none" style={{ color: 'var(--accent)' }}>
          Recent runs ({health.recentRuns.length})
        </summary>
        <div className="overflow-x-auto rounded-[8px] mt-2" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                {['When', 'Kind', 'Trigger', 'Status', 'Requests', 'Result'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {health.recentRuns.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                    {fmt(r.startedAt)}
                  </td>
                  <td className="px-3 py-2">{r.kind}</td>
                  <td className="px-3 py-2">{r.trigger}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : r.status === 'partial' ? 'info' : 'warning'} size="xs">
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular">{r.requestsUsed}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>
                    {r.error ??
                      (Object.entries(r.stats ?? {})
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
      </details>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
