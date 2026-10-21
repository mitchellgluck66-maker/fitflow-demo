'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Mail, Eye, Archive, Save, CheckCircle2, AlertTriangle, RefreshCw, FlaskConical } from 'lucide-react';
import { Card, CardHeader, Button, Badge, Toast, Input, PageHeader, PageBody, SampleDataBanner, Skeleton, SkeletonText, SkeletonTable, EmptyState, Toggle } from '@/components';
import { FetchError } from '@/components/FetchError';
import { fetchJson } from '@/lib/clientFetch';
import type { ReportsSettingsState, ReportCardState } from '@/lib/reports/settings';
import { LEGACY_KIND_LABELS, type ReportKind } from '@/lib/reports/kinds';

interface DigestRow {
  id: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  recipients: string[];
  subject: string;
  status: string;
  error: string | null;
  sentAt: string | null;
  isTest?: boolean;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'neutral' | 'danger' | 'warning'> = { sent: 'success', stored: 'info', skipped_empty: 'neutral', failed: 'danger', disabled: 'neutral' };
const STATUS_LABEL: Record<string, string> = { sent: 'Sent', stored: 'Rendered (not sent)', skipped_empty: 'Skipped · empty', failed: 'Failed', disabled: 'Disabled' };

function fmt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** One report's card (stage 3, item 3): switch, recipients, weekends (daily), status lines, Preview, Send test to me. */
const ReportSettingsCard: React.FC<{
  card: ReportCardState;
  emailConfigured: boolean;
  busy: string | null;
  onSave: (kind: ReportKind, patch: { enabled?: boolean; recipients?: string; includeWeekends?: boolean }) => Promise<void>;
  onPreview: (kind: ReportKind, label: string) => void;
  onTest: (kind: ReportKind, label: string) => Promise<void>;
}> = ({ card, emailConfigured, busy, onSave, onPreview, onTest }) => {
  const [recipients, setRecipients] = useState(card.recipients);
  const [seen, setSeen] = useState(card.recipients);
  // Re-sync the box when a save comes back (state adjusted during render, not in an effect).
  if (seen !== card.recipients) {
    setSeen(card.recipients);
    setRecipients(card.recipients);
  }
  const dirty = recipients !== card.recipients;
  return (
    <Card padding="lg" data-testid={`report-card-${card.kind}`}>
      <CardHeader
        title={card.label}
        subtitle={card.schedule}
        icon={Mail}
        action={
          <Badge variant={card.enabled ? (card.reason ? 'warning' : 'success') : 'neutral'} dot>
            {card.enabled ? (card.reason ? 'On · not sending' : 'On') : 'Off'}
          </Badge>
        }
      />
      <div className="space-y-3">
        <Toggle checked={card.enabled} onChange={(v) => onSave(card.kind, { enabled: v })} label={card.enabled ? 'On' : 'Off'} description={card.enabled ? `Next send ${card.nextSend?.label ?? '—'}` : 'Nothing is sent while off; Preview and Send test still work'} disabled={busy !== null} />
        {card.includeWeekends !== null && (
          <Toggle checked={card.includeWeekends} onChange={(v) => onSave(card.kind, { includeWeekends: v })} label="Include weekends" description={card.includeWeekends ? 'Also sends the reports for Saturday and Sunday' : 'The reports for Saturday and Sunday are skipped'} disabled={busy !== null} />
        )}
        <Input label="Recipients" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="jake@…, miranda@…" hint="Comma-separated. An invalid address refuses the save." />
        {card.reason && (
          <div role="status" className="flex items-start gap-2 px-3 py-2 rounded-[8px] text-[12.5px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }}>
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>{card.reason}</span>
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          <dt style={{ color: 'var(--text-quaternary)' }}>Next send</dt>
          <dd className="tabular">{card.nextSend ? `${card.nextSend.label} · ${card.nextSend.period.start === card.nextSend.period.end ? card.nextSend.period.start : `${card.nextSend.period.start} → ${card.nextSend.period.end}`}` : '—'}</dd>
          <dt style={{ color: 'var(--text-quaternary)' }}>Last sent</dt>
          <dd>{card.lastSent ? `${fmt(card.lastSent.at)} · ${card.lastSent.recipients.join(', ')}` : 'never'}</dd>
          <dt style={{ color: 'var(--text-quaternary)' }}>Last error</dt>
          <dd style={card.lastError ? { color: 'var(--danger)' } : undefined}>{card.lastError ? `${fmt(card.lastError.at)} · ${card.lastError.error}` : 'none'}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={Save} loading={busy === `save:${card.kind}`} disabled={busy !== null || !dirty} onClick={() => onSave(card.kind, { recipients })}>
            Save recipients
          </Button>
          <Button icon={Eye} disabled={busy !== null} onClick={() => onPreview(card.kind, card.label)}>
            Preview
          </Button>
          <Button icon={FlaskConical} loading={busy === `test:${card.kind}`} disabled={busy !== null || !emailConfigured} title={emailConfigured ? 'Sends the latest period to your own email, marked as a test' : 'Resend is not configured'} onClick={() => onTest(card.kind, card.label)}>
            Send test to me
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default function ReportsPage() {
  const [settings, setSettings] = useState<ReportsSettingsState | null>(null);
  const [digests, setDigests] = useState<DigestRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; src?: string; html?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([fetchJson<ReportsSettingsState>('/api/reports/settings'), fetchJson<{ digests: DigestRow[] }>('/api/email/digests')]);
      setSettings(s);
      setDigests(Array.isArray(d.digests) ? d.digests : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(id);
  }, [loadAll]);

  const save = async (kind: ReportKind, patch: { enabled?: boolean; recipients?: string; includeWeekends?: boolean }) => {
    setBusy(`save:${kind}`);
    try {
      const res = await fetch('/api/reports/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ...patch }) });
      const data = (await res.json().catch(() => ({}))) as ReportsSettingsState & { error?: string };
      if (res.ok) {
        setSettings(data);
        setToast({ message: patch.enabled !== undefined ? `${data.reports.find((r) => r.kind === kind)?.label} ${patch.enabled ? 'on' : 'off'}` : 'Saved', type: 'success' });
      } else setToast({ message: 'Could not save', detail: data.error, type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const openPreview = (kind: ReportKind, label: string) => setPreview({ title: `${label} — the latest period, rendered live (never sent)`, src: `/api/email/preview?kind=${kind}` });

  const sendTest = async (kind: ReportKind, label: string) => {
    setBusy(`test:${kind}`);
    try {
      const res = await fetch('/api/reports/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; recipients?: string[]; error?: string; status?: string };
      if (res.ok && data.ok) setToast({ message: `Test sent to ${(data.recipients ?? []).join(', ')}`, detail: `${label} · marked as a test in the archive`, type: 'success' });
      else setToast({ message: `${label} test failed`, detail: data.error ?? data.status, type: 'error' });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const openArchived = async (row: DigestRow) => {
    setBusy(`open:${row.id}`);
    try {
      const data = await fetchJson<{ html: string }>(`/api/email/digests?id=${row.id}`);
      setPreview({ title: row.subject, html: data.html });
    } catch (e) {
      setToast({ message: 'Could not open the report', detail: e instanceof Error ? e.message : String(e), type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Reports" description="Email reports and their archive" />
        <PageBody className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Card key={i} padding="lg">
                <Skeleton className="h-3 w-40 mb-4" />
                <SkeletonText lines={4} />
              </Card>
            ))}
          </div>
          <Card padding="lg">
            <Skeleton className="h-3 w-24 mb-4" />
            <SkeletonTable rows={6} cols={5} />
          </Card>
        </PageBody>
      </>
    );
  }

  const emailOk = Boolean(settings?.email.configured);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Daily, Weekly and Monthly — each on its own switch, each sent ${(settings?.sendsAt ?? 'Sends ~12:40 am').replace('Sends ', '')} business time for the period that just ended.`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={emailOk ? 'success' : 'warning'} dot>
              {emailOk ? `Resend · ${settings?.email.from ?? 'configured'}` : 'Resend not configured'}
            </Badge>
            <Button icon={RefreshCw} onClick={loadAll}>
              Refresh
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-5">
        <SampleDataBanner page="reports" />

        {loadError && !settings && <FetchError title="Could not load the reports" error={loadError} onRetry={loadAll} />}

        {!emailOk && settings && (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px]" style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}>
            <AlertTriangle size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12.5px]" style={{ color: 'var(--warning)' }}>
              Without <code>RESEND_API_KEY</code> + <code>RESEND_FROM_EMAIL</code> nothing is emailed. A report that is on is still rendered on schedule and archived below, so you can check it before going live.
            </p>
          </div>
        )}

        {settings && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {settings.reports.map((card) => (
              <ReportSettingsCard key={card.kind} card={card} emailConfigured={emailOk} busy={busy} onSave={save} onPreview={openPreview} onTest={sendTest} />
            ))}
          </div>
        )}

        {preview && (
          <Card padding="lg">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                {preview.title}
              </span>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Close
              </Button>
            </div>
            <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: '#f3f4f6' }}>
              <iframe title={preview.title} src={preview.src} srcDoc={preview.html} sandbox="" className="w-full" style={{ height: 820, border: 0, background: '#f3f4f6' }} />
            </div>
          </Card>
        )}

        {/* ---- Archive ---- */}
        <Card padding="lg">
          <CardHeader
            title="Archive"
            subtitle="Every report the schedule produced or you sent, sent or not. Click a row to open it."
            icon={Archive}
            action={
              <Badge variant="neutral" size="xs">
                {digests.length} report{digests.length === 1 ? '' : 's'}
              </Badge>
            }
          />
          {digests.length === 0 ? (
            <EmptyState icon={<Mail size={18} />} title="No reports yet" description="The first one appears after the first scheduled run past midnight with a report switched on, or when you press Send test to me above." />
          ) : (
            <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    {['Created', 'Report', 'Period', 'Recipients', 'Status', 'Subject'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {digests.map((d) => (
                    <tr key={d.id} onClick={() => openArchived(d)} className="cursor-pointer transition-colors hover:bg-[var(--surface-hover)]" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                        {fmt(d.createdAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {settings?.reports.find((k) => k.kind === d.kind)?.label ?? LEGACY_KIND_LABELS[d.kind] ?? d.kind}
                        {d.isTest && (
                          <Badge variant="info" size="xs" className="ml-1.5">
                            Test
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular">{d.periodStart === d.periodEnd ? d.periodStart : `${d.periodStart} → ${d.periodEnd}`}</td>
                      <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>
                        {d.recipients.join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS_VARIANT[d.status] ?? 'neutral'} size="xs">
                          {d.status === 'sent' && <CheckCircle2 size={10} className="mr-1" />}
                          {STATUS_LABEL[d.status] ?? d.status}
                        </Badge>
                        {d.error && (
                          <div className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>
                            {d.error}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 truncate max-w-[320px]" style={{ color: 'var(--text-tertiary)' }}>
                        {d.subject}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </>
  );
}
