'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Users, ChevronRight } from 'lucide-react';
import { Badge } from './Badge';
import { Loader } from './Loader';
import { EmptyState } from './PageHeader';

export interface Person {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  owner: string | null;
  stage: string | null;
  role: string | null;
  appliedAt: string | null;
  origin: string;
}

/**
 * Right-side slide-over listing the actual people behind a funnel bar. At
 * Jake's volumes, "12 no-shows" is 12 names Miranda can call.
 */
export const PeopleDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  contactIds: string[];
}> = ({ open, onClose, title, subtitle, contactIds }) => {
  // Results are keyed by the id list they were fetched for, so a stale list
  // never shows under a new title and no setState is needed on open.
  const key = contactIds.join(',');
  const [result, setResult] = useState<{ key: string; people: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = result && result.key === key ? result.people : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = key ? fetch(`/api/contacts?ids=${encodeURIComponent(key)}`).then((r) => r.json()) : Promise.resolve({ people: [] });
    load
      .then((d) => {
        if (!cancelled) setResult({ key, people: Array.isArray(d.people) ? d.people : [] });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, key]);

  if (!open) return null;

  const fmtDate = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso)) : '—';

  return (
    <div className="fixed inset-0 z-[90]">
      <div
        onClick={onClose}
        className="absolute inset-0 animate-fade"
        style={{ background: 'rgba(8, 9, 10, 0.45)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="absolute right-0 top-0 h-full w-full max-w-[460px] flex flex-col animate-fade"
        style={{
          background: 'var(--surface-raised)',
          borderLeft: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h2>
            {subtitle && (
              <p className="text-[12.5px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 h-6 w-6 grid place-items-center rounded-[6px] transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <X size={14} strokeWidth={2.3} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <p className="px-5 py-4 text-[12.5px]" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
          {!error && people === null && (
            <div className="py-16 grid place-items-center">
              <Loader />
            </div>
          )}
          {people && people.length === 0 && (
            <EmptyState icon={<Users size={18} />} title="Nobody at this stage" description="No contacts reached this stage in the selected period." />
          )}
          {people && people.length > 0 && (
            <ul>
              {people.map((p) => (
                <li key={p.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Link
                    href={`/clients/${p.id}`}
                    className="px-5 py-3 flex items-start gap-3 transition-colors hover:bg-[var(--surface-hover)]"
                    title={`Open ${p.name}'s profile`}
                  >
                  <div
                    className="h-8 w-8 shrink-0 grid place-items-center rounded-full text-[12px] font-semibold"
                    style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
                  >
                    {p.name
                      .split(/\s+/)
                      .map((s) => s[0])
                      .slice(0, 2)
                      .join('')
                      .toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {p.name}
                      </span>
                      {p.origin === 'demo' && (
                        <Badge variant="warning" size="xs">
                          sample
                        </Badge>
                      )}
                    </div>
                    <div className="text-[12px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {p.email ?? p.phone ?? '—'}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
                      <span>Source: {p.source ?? 'Unknown'}</span>
                      <span>Now: {p.stage ?? 'Unassigned'}</span>
                      <span>Applied {fmtDate(p.appliedAt)}</span>
                      {p.owner && <span>Owner: {p.owner}</span>}
                    </div>
                  </div>
                  <ChevronRight size={14} className="shrink-0 mt-2" style={{ color: 'var(--text-quaternary)' }} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 text-[11.5px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-quaternary)' }}>
          {people ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'Loading…'} · read from GoHighLevel
        </div>
      </aside>
    </div>
  );
};
