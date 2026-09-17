'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Clock, RefreshCw } from 'lucide-react';
import { Button } from './Button';

interface Status {
  configured: boolean;
  lastSuccessAt: string | null;
  ageHours: number | null;
  stale: boolean;
  staleAfterHours: number;
  inProgress: boolean;
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
 * Slim amber banner on every data page when the last COMPLETED GoHighLevel
 * sync is older than 26 hours (or never ran while GHL is connected).
 * "Sync now" runs the same resumable delta the cron runs; a partial run
 * keeps the banner (with progress) until the cycle completes.
 */
export const StaleSyncBanner: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
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
  if (!status || !status.configured || !status.stale) return null;

  const syncNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const d = await res.json();
      setNote(d.message ?? (d.ok ? 'Synced.' : 'Sync failed.'));
      await load();
      router.refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-1.5 text-[12.5px]"
      style={{ background: 'var(--warning-muted)', borderBottom: '1px solid var(--warning-border)', color: 'var(--warning)' }}
    >
      <Clock size={13} strokeWidth={2.4} className="shrink-0" />
      <span>
        Pipeline data last synced <strong>{relativeAge(status.lastSuccessAt)}</strong>
        {status.inProgress ? ' · a sync cycle is in progress and will finish on the next run' : ''}
        {note ? ` · ${note}` : ''}
      </span>
      <Button variant="ghost" icon={RefreshCw} loading={busy} onClick={syncNow} className="h-6 px-2 text-[12px]">
        Sync now
      </Button>
    </div>
  );
};
