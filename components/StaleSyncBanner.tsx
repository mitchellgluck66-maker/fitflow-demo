'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Clock, RefreshCw, GitCompareArrows } from 'lucide-react';
import { Button } from './Button';

interface SourceFreshness {
  key: 'ghl' | 'meta' | 'stripe';
  label: string;
  configured: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  syncEndpoint: string;
  syncBody: Record<string, string>;
}
interface Status {
  staleSources: SourceFreshness[];
  inProgress: boolean;
  reconcile: { at: string; ok: boolean; mismatches: number; stagesChecked: number } | null;
}

/** Pages without pipeline data on them. */
const QUIET_PATHS = ['/login', '/setup', '/reports'];

export function relativeAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Slim amber banner on every data page when ANY connected source — GHL, Meta
 * or Stripe — last completed a sync more than 26 hours ago (or never), naming
 * the source and offering its own sync button. Also shows when the nightly
 * reconciliation found the mirror drifting from GoHighLevel.
 */
export const StaleSyncBanner: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch('/api/sync/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Status | null) => setStatus(d))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (QUIET_PATHS.some((p) => pathname.startsWith(p))) return;
    load();
  }, [load, pathname]);

  if (QUIET_PATHS.some((p) => pathname.startsWith(p))) return null;
  if (!status) return null;
  const stale = status.staleSources ?? [];
  const drift = status.reconcile && !status.reconcile.ok ? status.reconcile : null;
  if (stale.length === 0 && !drift) return null;

  const syncNow = async (s: SourceFreshness) => {
    setBusy(s.key);
    setNote(null);
    try {
      const res = await fetch(s.syncEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.syncBody) });
      const d = await res.json();
      setNote(`${s.label}: ${d.message ?? (d.ok ? 'synced.' : 'sync failed.')}`);
      await load();
      router.refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-1.5 text-[12.5px]"
      style={{ background: 'var(--warning-muted)', borderBottom: '1px solid var(--warning-border)', color: 'var(--warning)' }}
    >
      {stale.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-2">
          <Clock size={13} strokeWidth={2.4} className="shrink-0" />
          <span>
            {s.label} last synced <strong>{relativeAge(s.lastSuccessAt)}</strong>
            {s.key === 'ghl' && status.inProgress ? ' · a sync cycle is in progress and will finish on the next run' : ''}
          </span>
          <Button variant="ghost" icon={RefreshCw} loading={busy === s.key} disabled={busy !== null && busy !== s.key} onClick={() => syncNow(s)} className="h-6 px-2 text-[12px]">
            Sync now
          </Button>
        </span>
      ))}
      {drift && (
        <span className="inline-flex items-center gap-2">
          <GitCompareArrows size={13} strokeWidth={2.4} className="shrink-0" />
          <span>
            Mirror differs from GoHighLevel on <strong>{drift.mismatches}</strong> of {drift.stagesChecked} stages (reconciled {relativeAge(drift.at)}) —{' '}
            <Link href="/setup" className="underline">
              see Sync health
            </Link>
          </span>
        </span>
      )}
      {note && <span style={{ color: 'var(--text-secondary)' }}>· {note}</span>}
    </div>
  );
};
