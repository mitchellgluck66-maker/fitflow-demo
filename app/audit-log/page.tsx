'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ScrollText,
  Check,
  CalendarX,
  UserMinus,
  RefreshCw,
  ArrowRight,
  Search,
  Filter,
} from 'lucide-react';
import {
  Card,
  Badge,
  Toast,
  Input,
  PageHeader,
  PageBody,
  PageLoader,
  EmptyState,
} from '@/components';

interface LeadEvent {
  id: string;
  leadId: string;
  action: string;
  priorStage: string | null;
  newStage: string | null;
  appointmentStatus: string | null;
  actor: string;
  notes: string | null;
  syncStatus: string;
  createdAt: string;
  leadName?: string;
}

const ACTION_META: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'; icon: typeof Check }
> = {
  MarkAttended: { label: 'Booked', variant: 'success', icon: Check },
  MarkNoShow: { label: 'No Show', variant: 'warning', icon: CalendarX },
  MarkNotContinuing: { label: 'Not Continuing', variant: 'danger', icon: UserMinus },
  GhlSyncRun: { label: 'Sync Run', variant: 'accent', icon: RefreshCw },
  Enroll: { label: 'Enrolled', variant: 'success', icon: Check },
  StatusUpdate: { label: 'Status Update', variant: 'info', icon: ArrowRight },
  Created: { label: 'Created', variant: 'neutral', icon: ScrollText },
};

const SYNC_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  synced: 'success',
  local: 'neutral',
  syncing: 'warning',
  failed: 'danger',
};

export default function AuditLogPage() {
  const [events, setEvents] = useState<LeadEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'error' } | null>(null);

  useEffect(() => {
    fetch('/api/events')
      .then((r) => r.json())
      .then((d) => setEvents(Array.isArray(d) ? d : []))
      .catch(() => setToast({ message: 'Could not load the audit log', type: 'error' }))
      .finally(() => setLoading(false));
  }, []);

  const actions = useMemo(
    () => Array.from(new Set(events.map((e) => e.action))),
    [events],
  );

  const filtered = useMemo(() => {
    let result = action ? events.filter((e) => e.action === action) : events;

    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (e) =>
          (e.leadName ?? '').toLowerCase().includes(q) ||
          e.actor.toLowerCase().includes(q) ||
          (e.notes ?? '').toLowerCase().includes(q),
      );
    }

    // Newest first - an audit log is read from the top.
    return [...result].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [events, action, query]);

  const formatWhen = (iso: string) => {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60_000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    if (mins < 10080) return `${Math.floor(mins / 1440)}d ago`;

    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(date);
  };

  const formatExact = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Audit Log" description="Immutable record of every action" />
        <PageBody>
          <PageLoader />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Every attendance mark, stage change and sync, recorded immutably."
        actions={
          <Badge variant="neutral">
            <span className="tabular">{events.length}</span> events
          </Badge>
        }
      />

      <PageBody className="space-y-4">
        {/* Filters */}
        <Card padding="sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-56">
              <Input
                icon={Search}
                placeholder="Search lead, actor, notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div
              className="h-5 w-px mx-1 hidden sm:block"
              style={{ background: 'var(--border-subtle)' }}
            />

            <Filter size={13} style={{ color: 'var(--text-quaternary)' }} />

            <button
              onClick={() => setAction(null)}
              className="h-7 px-2.5 rounded-[6px] text-[12.5px] font-medium transition-all duration-150 hover:bg-[var(--surface-hover)]"
              style={
                action === null
                  ? {
                      background: 'var(--accent)',
                      color: 'var(--accent-text)',
                      boxShadow: 'var(--shadow-accent)',
                    }
                  : { color: 'var(--text-tertiary)' }
              }
            >
              All
              <span className="ml-1.5 tabular opacity-70">{events.length}</span>
            </button>

            {actions.map((a) => {
              const meta = ACTION_META[a] ?? {
                label: a,
                variant: 'neutral' as const,
                icon: ScrollText,
              };
              const count = events.filter((e) => e.action === a).length;
              const active = action === a;

              return (
                <button
                  key={a}
                  onClick={() => setAction(active ? null : a)}
                  className="h-7 px-2.5 rounded-[6px] text-[12.5px] font-medium transition-all duration-150 hover:bg-[var(--surface-hover)]"
                  style={
                    active
                      ? {
                          background: 'var(--accent)',
                          color: 'var(--accent-text)',
                          boxShadow: 'var(--shadow-accent)',
                        }
                      : { color: 'var(--text-tertiary)' }
                  }
                >
                  {meta.label}
                  <span className="ml-1.5 tabular opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Timeline */}
        {filtered.length === 0 ? (
          <Card>
            <EmptyState
              icon={<ScrollText size={19} />}
              title="No events recorded"
              description="Actions taken in the Today View will appear here as they happen."
            />
          </Card>
        ) : (
          <Card padding="none" className="overflow-hidden">
            <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {filtered.map((event) => {
                const meta = ACTION_META[event.action] ?? {
                  label: event.action,
                  variant: 'neutral' as const,
                  icon: ScrollText,
                };
                const Icon = meta.icon;
                const moved =
                  event.priorStage &&
                  event.newStage &&
                  event.priorStage !== event.newStage;

                return (
                  <div
                    key={event.id}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-hover)]"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div
                      className="h-7 w-7 grid place-items-center rounded-[7px] shrink-0 mt-px"
                      style={{
                        background: `var(--${meta.variant === 'accent' ? 'accent' : meta.variant}-muted, var(--surface-hover))`,
                        color: `var(--${meta.variant === 'accent' ? 'accent' : meta.variant}, var(--text-tertiary))`,
                      }}
                    >
                      <Icon size={13.5} strokeWidth={2.3} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={meta.variant} size="xs">
                          {meta.label}
                        </Badge>
                        {event.leadName && (
                          <span
                            className="text-[13px] font-medium"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {event.leadName}
                          </span>
                        )}
                        {moved && (
                          <span
                            className="inline-flex items-center gap-1 text-[11.5px]"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {event.priorStage}
                            <ArrowRight size={10} strokeWidth={2.4} />
                            <span style={{ color: 'var(--text-secondary)' }}>
                              {event.newStage}
                            </span>
                          </span>
                        )}
                      </div>

                      {event.notes && (
                        <p
                          className="text-[12px] mt-1 leading-relaxed"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          {event.notes}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-1.5">
                        <span
                          className="text-[11px]"
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {event.actor}
                        </span>
                        <span style={{ color: 'var(--text-quaternary)' }}>·</span>
                        <span
                          title={formatExact(event.createdAt)}
                          className="text-[11px] tabular"
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {formatWhen(event.createdAt)}
                        </span>
                      </div>
                    </div>

                    <Badge
                      variant={SYNC_VARIANT[event.syncStatus] ?? 'neutral'}
                      size="xs"
                      className="shrink-0 mt-0.5"
                    >
                      {event.syncStatus}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </PageBody>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          isVisible={!!toast}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
