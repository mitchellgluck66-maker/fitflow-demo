'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Send,
  RefreshCw,
  Download,
  CheckCircle2,
  Clock,
  Mail,
} from 'lucide-react';
import {
  Card,
  Badge,
  Button,
  Toast,
  Modal,
  Input,
  PageHeader,
  PageBody,
  PageLoader,
  EmptyState,
  OutcomeButtons,
  type Outcome,
} from '@/components';

interface DayAppointment {
  id: string;
  leadId: string;
  type: string;
  startTime: string;
  endTime: string | null;
  assignedTo: string | null;
  outcome: Outcome | null;
  outcomeMarkedBy: string | null;
  syncStatus: string;
  firstName: string;
  lastName: string;
  email: string;
  stage: string;
  source: string | null;
  owner: string | null;
}

interface DaySummary {
  total: number;
  marked: number;
  unmarked: number;
  booked: number;
  noShow: number;
  notContinuing: number;
}

const TYPE_VARIANT: Record<string, 'accent' | 'info' | 'success' | 'neutral'> = {
  Consult: 'accent',
  Roadmap: 'info',
  'Follow-Up': 'neutral',
  'Check-In': 'success',
};

function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export default function TodayPage() {
  const [date, setDate] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [appointments, setAppointments] = useState<DayAppointment[]>([]);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail?: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportEmail, setExportEmail] = useState('');
  const [recentEmails, setRecentEmails] = useState<string[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const fetchDay = useCallback(async (target?: string) => {
    try {
      const res = await fetch(
        target ? `/api/appointments?date=${target}` : '/api/appointments',
      );
      const data = await res.json();
      setAppointments(data.appointments ?? []);
      setSummary(data.summary ?? null);
      setDate(data.date);
      setTimezone(data.timezone ?? 'America/New_York');
    } catch {
      setToast({ message: 'Could not load appointments', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDay();
  }, [fetchDay]);

  const markOutcome = async (id: string, outcome: Outcome) => {
    setSavingId(id);
    // Optimistic - the click must feel instant when working through a list.
    setAppointments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, outcome, syncStatus: 'queued' } : a)),
    );

    try {
      const res = await fetch(`/api/appointments/${id}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setToast({
        message: data.stageChanged
          ? `${data.label} — moved to ${data.newStage}`
          : `${data.label} recorded`,
        detail: `${data.queuedOperations} GoHighLevel ${data.queuedOperations === 1 ? 'update' : 'updates'} queued`,
        type: 'success',
      });

      await fetchDay(date);
    } catch {
      setToast({ message: 'Could not save that outcome', type: 'error' });
      await fetchDay(date);
    } finally {
      setSavingId(null);
    }
  };

  const clearOutcome = async (id: string) => {
    setSavingId(id);
    setAppointments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, outcome: null } : a)),
    );
    try {
      await fetch(`/api/appointments/${id}/outcome`, { method: 'DELETE' });
      await fetchDay(date);
    } finally {
      setSavingId(null);
    }
  };

  const openExport = async () => {
    setExportOpen(true);
    try {
      const res = await fetch(`/api/export/day-summary?date=${date}`);
      const data = await res.json();
      setExportEmail(data.rememberedEmail ?? '');
      setRecentEmails(data.recentEmails ?? []);
      setEmailConfigured(Boolean(data.emailConfigured));
    } catch {
      /* dialog still works with a blank field */
    }
  };

  const sendSummary = async () => {
    if (!exportEmail.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/export/day-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: exportEmail.trim(), date }),
      });
      const data = await res.json();
      setToast({
        message: data.sent ? 'Day summary sent' : 'Could not send',
        detail: data.message,
        type: data.sent ? 'success' : 'error',
      });
      if (data.sent) setExportOpen(false);
    } finally {
      setSending(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      setToast({
        message: data.dryRun ? 'Dry run complete' : 'Synced to GoHighLevel',
        detail: data.message,
        type: 'success',
      });
      await fetchDay(date);
    } finally {
      setSyncing(false);
    }
  };

  const dayLabel = useMemo(() => {
    if (!date) return '';
    const [y, m, d] = date.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }, [date]);

  const formatTime = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(iso));
    } catch {
      return '--:--';
    }
  };

  const progress =
    summary && summary.total > 0
      ? Math.round((summary.marked / summary.total) * 100)
      : 0;
  const complete = progress === 100 && (summary?.total ?? 0) > 0;

  if (loading) {
    return (
      <>
        <PageHeader title="Today" description="Mark attendance for each appointment" />
        <PageBody>
          <PageLoader label="Loading schedule" />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Today"
        description="Mark each appointment's outcome. Everything syncs to GoHighLevel at midnight."
        actions={
          <>
            <Button icon={RefreshCw} loading={syncing} onClick={runSync}>
              Sync now
            </Button>
            <Button variant="primary" icon={Send} onClick={openExport}>
              Export Summary
            </Button>
          </>
        }
      >
        {/* Date navigation */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-[8px]"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-xs)',
            }}
          >
            <button
              onClick={() => fetchDay(shiftDate(date, -1))}
              aria-label="Previous day"
              className="h-[26px] w-[26px] grid place-items-center rounded-[6px] transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <ChevronLeft size={14} strokeWidth={2.3} />
            </button>
            <button
              onClick={() => fetchDay()}
              className="h-[26px] px-2.5 rounded-[6px] text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Today
            </button>
            <button
              onClick={() => fetchDay(shiftDate(date, 1))}
              aria-label="Next day"
              className="h-[26px] w-[26px] grid place-items-center rounded-[6px] transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <ChevronRight size={14} strokeWidth={2.3} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <CalendarDays size={14} style={{ color: 'var(--text-quaternary)' }} />
            <span
              className="text-[13.5px] font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {dayLabel}
            </span>
          </div>

          <input
            type="date"
            value={date}
            onChange={(e) => fetchDay(e.target.value)}
            className="h-[28px] px-2 text-[12.5px] rounded-[7px]"
          />
        </div>
      </PageHeader>

      <PageBody className="space-y-4">
        {/* Progress */}
        {summary && summary.total > 0 && (
          <Card padding="md">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-2.5">
                <div
                  className="h-7 w-7 grid place-items-center rounded-[7px]"
                  style={{
                    background: complete ? 'var(--success-muted)' : 'var(--accent-muted)',
                    color: complete ? 'var(--success)' : 'var(--accent)',
                  }}
                >
                  {complete ? <CheckCircle2 size={15} strokeWidth={2.3} /> : <Clock size={15} strokeWidth={2.3} />}
                </div>
                <div>
                  <div
                    className="text-[13.5px] font-semibold"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {summary.marked} of {summary.total} marked
                  </div>
                  <div
                    className="text-[12px] mt-0.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {complete
                      ? 'All done — queued for the midnight sync.'
                      : `${summary.unmarked} still need an outcome before midnight.`}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Badge variant="success" dot>{summary.booked} booked</Badge>
                <Badge variant="warning" dot>{summary.noShow} no-show</Badge>
                <Badge variant="danger" dot>{summary.notContinuing} not continuing</Badge>
              </div>
            </div>

            <div
              className="h-1.5 w-full rounded-full overflow-hidden"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: `${progress}%`,
                  background: complete ? 'var(--success)' : 'var(--accent)',
                  boxShadow: complete ? 'none' : 'var(--shadow-accent)',
                }}
              />
            </div>
          </Card>
        )}

        {/* Appointment list */}
        {appointments.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarDays size={19} />}
              title="No appointments scheduled"
              description={`Nothing on the calendar for ${dayLabel}.`}
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-2 stagger">
            {appointments.map((appt) => {
              const saving = savingId === appt.id;
              const marked = Boolean(appt.outcome);

              return (
                <Card
                  key={appt.id}
                  padding="none"
                  className="overflow-hidden transition-all duration-200"
                >
                  <div className="flex flex-wrap items-center gap-4 px-4 py-3">
                    {/* Time rail */}
                    <div className="flex items-center gap-3 min-w-[132px]">
                      <div
                        className="w-[3px] h-9 rounded-full shrink-0 transition-colors duration-300"
                        style={{
                          background: marked
                            ? appt.outcome === 'booked'
                              ? 'var(--success)'
                              : appt.outcome === 'no_show'
                                ? 'var(--warning)'
                                : 'var(--danger)'
                            : 'var(--border-default)',
                        }}
                      />
                      <div>
                        <div
                          className="text-[14px] font-semibold tabular leading-tight"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {formatTime(appt.startTime)}
                        </div>
                        {appt.endTime && (
                          <div
                            className="text-[11.5px] tabular mt-0.5"
                            style={{ color: 'var(--text-quaternary)' }}
                          >
                            to {formatTime(appt.endTime)}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Person */}
                    <div className="flex-1 min-w-[200px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-[13.5px] font-medium"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {appt.firstName} {appt.lastName}
                        </span>
                        <Badge variant={TYPE_VARIANT[appt.type] ?? 'neutral'} size="xs">
                          {appt.type}
                        </Badge>
                      </div>
                      <div
                        className="text-[12px] mt-0.5 truncate"
                        style={{ color: 'var(--text-quaternary)' }}
                      >
                        {appt.email}
                        {appt.assignedTo && ` · ${appt.assignedTo}`}
                      </div>
                    </div>

                    {/* Stage */}
                    <div className="min-w-[150px] hidden lg:block">
                      <div
                        className="text-[10.5px] font-semibold uppercase tracking-[0.05em]"
                        style={{ color: 'var(--text-quaternary)' }}
                      >
                        Stage
                      </div>
                      <div
                        className="text-[12.5px] mt-0.5 truncate"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {appt.stage}
                      </div>
                    </div>

                    {/* Outcome */}
                    <div className="flex flex-col items-end gap-1">
                      <OutcomeButtons
                        selected={appt.outcome}
                        onSelect={(o) => markOutcome(appt.id, o)}
                        onClear={() => clearOutcome(appt.id)}
                        disabled={saving}
                        size="sm"
                      />
                      {marked && (
                        <span
                          className="text-[10.5px]"
                          style={{ color: 'var(--text-quaternary)' }}
                        >
                          {appt.syncStatus === 'synced'
                            ? 'Synced to GoHighLevel'
                            : 'Queued for midnight sync'}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </PageBody>

      {/* Export dialog */}
      <Modal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export Day Summary"
        description={`Send the ${dayLabel} attendance recap.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Send}
              loading={sending}
              disabled={!exportEmail.trim()}
              onClick={sendSummary}
            >
              Send
            </Button>
          </>
        }
      >
        <Input
          label="Send to"
          icon={Mail}
          type="email"
          placeholder="name@example.com"
          value={exportEmail}
          onChange={(e) => setExportEmail(e.target.value)}
          hint="This address is remembered and pre-filled next time."
        />

        {recentEmails.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {recentEmails.map((email) => (
              <button
                key={email}
                onClick={() => setExportEmail(email)}
                className="h-6 px-2 rounded-[5px] text-[11.5px] transition-colors hover:bg-[var(--surface-active)]"
                style={{
                  background: 'var(--surface-hover)',
                  color: 'var(--text-secondary)',
                }}
              >
                {email}
              </button>
            ))}
          </div>
        )}

        {!emailConfigured && (
          <div
            className="mt-4 px-3 py-2.5 rounded-[8px] text-[12px] leading-relaxed"
            style={{
              background: 'var(--warning-muted)',
              border: '1px solid var(--warning-border)',
              color: 'var(--warning)',
            }}
          >
            No Resend API key configured yet, so sending is disabled. You can still
            download the summary below.
          </div>
        )}

        <a
          href={`/api/export/day-summary?date=${date}&format=csv`}
          className="inline-flex items-center gap-1.5 mt-4 text-[12.5px] transition-colors hover:opacity-80"
          style={{ color: 'var(--accent)' }}
        >
          <Download size={13} strokeWidth={2.2} />
          Download as CSV
        </a>
      </Modal>

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
