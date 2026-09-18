'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eraser } from 'lucide-react';
import { AccordionCard, Badge, Button, Toast } from '@/components';
import { groupIncidents, type IncidentGroup, type IncidentRow } from './incidentGrouping';

const INITIAL_ROWS = 5;
const PAGE_SIZE = 25;

function fmt(iso: string): string {
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

/**
 * The incident/error log, its own Setup section. Consecutive identical errors
 * collapse into one ×N row (see incidentGrouping.ts); the 5 most recent rows
 * show by default, "Show all" paginates the rest; resolved incidents live
 * behind a toggle. Defaults open only while incidents are open.
 */
export const IncidentLog: React.FC = () => {
  const [open, setOpen] = useState<IncidentRow[] | null>(null);
  const [resolved, setResolved] = useState<IncidentRow[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [pageIdx, setPageIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetch('/api/incidents').then((r) => r.json());
      setOpen(data.incidents ?? []);
      if (showResolved) {
        const res = await fetch('/api/incidents?resolved=1').then((r) => r.json());
        setResolved(res.incidents ?? []);
      }
    } catch {
      setToast({ message: 'Could not load incidents', type: 'error' });
    }
  }, [showResolved]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const toggleResolved = async () => {
    const next = !showResolved;
    setShowResolved(next);
    setPageIdx(0);
    if (next && resolved === null) {
      try {
        const res = await fetch('/api/incidents?resolved=1').then((r) => r.json());
        setResolved(res.incidents ?? []);
      } catch {
        setToast({ message: 'Could not load resolved incidents', type: 'error' });
      }
    }
  };

  const resolveGroup = async (g: IncidentGroup) => {
    setBusy(g.id);
    try {
      const body = g.ids.length === 1 ? { id: g.ids[0] } : { ids: g.ids };
      const res = await fetch('/api/incidents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.ok) {
        setToast({ message: g.count === 1 ? 'Incident resolved' : `${g.count} incidents resolved`, type: 'success' });
        setResolved(null); // stale now; refetched on demand
        await load();
      } else {
        setToast({ message: res.error ?? 'Could not resolve', type: 'error' });
      }
    } finally {
      setBusy(null);
    }
  };

  const resolveNoise = async () => {
    setBusy('noise');
    try {
      const res = await fetch('/api/incidents', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noise: true }) }).then((r) => r.json());
      if (res.ok) {
        setToast({ message: res.total ? `${res.total} noise incident${res.total === 1 ? '' : 's'} resolved — ${res.openAfter} open remain` : 'No noise to resolve', type: 'success' });
        setResolved(null);
        await load();
      } else {
        setToast({ message: res.error ?? 'Could not sweep', type: 'error' });
      }
    } finally {
      setBusy(null);
    }
  };

  const openGroups = useMemo(() => groupIncidents(open ?? []), [open]);
  const resolvedGroups = useMemo(() => (showResolved ? groupIncidents(resolved ?? []) : []), [showResolved, resolved]);
  const allGroups = useMemo(() => [...openGroups, ...resolvedGroups], [openGroups, resolvedGroups]);

  const pageCount = Math.max(1, Math.ceil(allGroups.length / PAGE_SIZE));
  const page = Math.min(pageIdx, pageCount - 1);
  const visible = showAll ? allGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : allGroups.slice(0, INITIAL_ROWS);
  const hiddenCount = allGroups.length - INITIAL_ROWS;

  const openCount = openGroups.reduce((s, g) => s + g.count, 0);

  return (
    <AccordionCard
      title="Incidents"
      summary={open === null ? 'Loading…' : openCount === 0 ? 'None open' : `${openCount} open`}
      subtitle="Errors, silences and drift raised by the syncs. Consecutive identical errors are grouped."
      icon={AlertTriangle}
      defaultOpen={openCount > 0}
      action={
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={Eraser} loading={busy === 'noise'} onClick={resolveNoise} title="Resolve unmapped-stage incidents from unfollowed / mapped / archived pipelines, stale silence notices and duplicate errors">
            Resolve all noise
          </Button>
          <Badge variant={openCount ? 'warning' : 'success'} dot>
          {open === null ? '…' : openCount ? `${openCount} open` : 'All clear'}
          </Badge>
        </div>
      }
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="ghost" onClick={toggleResolved}>
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </Button>
      </div>

      {allGroups.length === 0 ? (
        <p className="text-[12.5px] flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
          <CheckCircle2 size={13} style={{ color: 'var(--positive, var(--success))' }} />
          {showResolved ? 'No incidents at all.' : 'No open incidents.'}
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {visible.map((g) => (
              <li
                key={g.id}
                className="flex items-start gap-2 px-3 py-2 rounded-[8px] text-[12.5px]"
                style={{
                  background: g.resolved ? 'var(--surface-sunken)' : g.severity === 'critical' ? 'var(--danger-muted)' : 'var(--warning-muted)',
                  border: `1px solid ${g.resolved ? 'var(--border-subtle)' : g.severity === 'critical' ? 'var(--danger-border)' : 'var(--warning-border)'}`,
                  color: g.resolved ? 'var(--text-tertiary)' : g.severity === 'critical' ? 'var(--negative, var(--danger))' : 'var(--warning)',
                }}
              >
                <Badge variant="neutral" size="xs">
                  {g.kind}
                </Badge>
                <span className="flex-1 min-w-0 break-words">{g.message}</span>
                {g.count > 1 && (
                  <Badge variant="neutral" size="xs">
                    ×{g.count}
                  </Badge>
                )}
                <span
                  className="text-[11px] opacity-70 whitespace-nowrap"
                  title={g.count > 1 ? `First ${fmt(g.firstAt)} — last ${fmt(g.lastAt)}` : fmt(g.lastAt)}
                >
                  {g.count > 1 ? `${ago(g.firstAt)} – ${ago(g.lastAt)}` : ago(g.lastAt)}
                </span>
                {g.resolved ? (
                  <Badge variant="neutral" size="xs">
                    resolved
                  </Badge>
                ) : (
                  <Button variant="ghost" loading={busy === g.id} onClick={() => resolveGroup(g)}>
                    {g.count > 1 ? `Resolve all ${g.count}` : 'Resolve'}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-2 flex items-center gap-2">
            {!showAll && hiddenCount > 0 && (
              <Button variant="ghost" onClick={() => setShowAll(true)}>
                Show all ({allGroups.length})
              </Button>
            )}
            {showAll && (
              <>
                <Button variant="ghost" onClick={() => { setShowAll(false); setPageIdx(0); }}>
                  Show fewer
                </Button>
                {pageCount > 1 && (
                  <>
                    <div className="flex-1" />
                    <Button variant="ghost" disabled={page === 0} onClick={() => setPageIdx(page - 1)}>
                      Prev
                    </Button>
                    <span className="text-[11.5px] tabular" style={{ color: 'var(--text-quaternary)' }}>
                      {page + 1} / {pageCount}
                    </span>
                    <Button variant="ghost" disabled={page >= pageCount - 1} onClick={() => setPageIdx(page + 1)}>
                      Next
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
