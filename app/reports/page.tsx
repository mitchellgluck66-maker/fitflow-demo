'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Mail, Send, Eye, Archive, Save, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Badge,
  Toast,
  Input,
  PageHeader,
  PageBody,
  SampleDataBanner,
  Skeleton,
  SkeletonText,
  SkeletonTable,
  EmptyState,
  Toggle,
} from '@/components';

type Kind = 'daily_todo' | 'weekly' | 'monthly';

const KINDS: Array<{ kind: Kind; label: string; schedule: string }> = [
  { kind: 'daily_todo', label: 'Daily to-do', schedule: 'Every day · 7am' },
  { kind: 'weekly', label: 'Weekly scorecard', schedule: 'Mondays · 7am' },
  { kind: 'monthly', label: 'Monthly scorecard', schedule: '1st of the month · 7am' },
];

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
  createdAt: string;
}

interface SettingsData {
  timezone: string;
  digestRecipientsTodo: string;
  digestRecipientsWeekly: string;
  digestRecipientsMonthly: string;
  digestEnabledTodo: boolean;
  digestEnabledWeekly: boolean;
  digestEnabledMonthly: boolean;
  email: { configured: boolean; from: string | null };
}

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'neutral' | 'danger' | 'warning'> = {
  sent: 'success',
  stored: 'info',
  skipped_empty: 'neutral',
  failed: 'danger',
  disabled: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  sent: 'Sent',
  stored: 'Rendered (not sent)',
  skipped_empty: 'Skipped · empty',
  failed: 'Failed',
  disabled: 'Disabled',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ReportsPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [digests, setDigests] = useState<DigestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [recipients, setRecipients] = useState({ todo: '', weekly: '', monthly: '' });
  const [enabled, setEnabled] = useState({ todo: true, weekly: true, monthly: true });
  const [preview, setPreview] = useState<{ title: string; src?: string; html?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        fetch('/api/settings').then((r) => r.json()),
        fetch('/api/email/digests').then((r) => r.json()),
      ]);
      setSettings(s);
      setRecipients({
        todo: s.digestRecipientsTodo ?? '',
        weekly: s.digestRecipientsWeekly ?? '',
        monthly: s.digestRecipientsMonthly ?? '',
      });
      setEnabled({
        todo: s.digestEnabledTodo !== false,
        weekly: s.digestEnabledWeekly !== false,
        monthly: s.digestEnabledMonthly !== false,
      });
      setDigests(Array.isArray(d.digests) ? d.digests : []);
    } catch {
      setToast({ message: 'Could not load reports', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body.
    const id = setTimeout(() => {
      void loadAll();
    }, 0);
    return () => clearTimeout(id);
  }, [loadAll]);

  const saveRecipients = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digestRecipientsTodo: recipients.todo,
          digestRecipientsWeekly: recipients.weekly,
          digestRecipientsMonthly: recipients.monthly,
          digestEnabledTodo: enabled.todo,
          digestEnabledWeekly: enabled.weekly,
          digestEnabledMonthly: enabled.monthly,
        }),
      });
      const data = await res.json();
      setToast({ message: data.ok ? 'Digest settings saved' : 'Could not save', detail: data.error, type: data.ok ? 'success' : 'error' });
    } finally {
      setBusy(null);
    }
  };

  const openPreview = (kind: Kind, label: string) => {
    setPreview({ title: `${label} — live preview`, src: `/api/email/preview?kind=${kind}` });
  };

  const sendNow = async (kind: Kind, label: string) => {
    setBusy(`send:${kind}`);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      const detail =
        data.status === 'sent'
          ? `Sent to ${(data.recipients ?? []).join(', ')}`
          : data.status === 'stored'
            ? 'Resend is not configured — the digest was rendered and archived instead.'
            : (data.error ?? data.detail ?? data.status);
      setToast({
        message: data.status === 'sent' ? `${label} sent` : data.status === 'stored' ? `${label} archived` : `${label} failed`,
        detail,
        type: data.status === 'sent' ? 'success' : data.status === 'stored' ? 'info' : 'error',
      });
      await loadAll();
    } finally {
      setBusy(null);
    }
  };

  const openArchived = async (row: DigestRow) => {
    setBusy(`open:${row.id}`);
    try {
      const res = await fetch(`/api/email/digests?id=${row.id}`);
      const data = await res.json();
      setPreview({ title: `${row.subject}`, html: data.html });
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Reports" description="Email digests and their archive" />
        <PageBody className="space-y-4" aria-busy="true">
          <Card padding="lg">
            <Skeleton className="h-3 w-40 mb-4" />
            <SkeletonText lines={3} />
          </Card>
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
        description="The daily to-do, Monday scorecard and monthly scorecard — who gets them, what they look like, and every one that went out."
        actions={
          <Button icon={RefreshCw} onClick={loadAll}>
            Refresh
          </Button>
        }
      />

      <PageBody className="space-y-5">
        <SampleDataBanner page="reports" />

        {/* ---- Digest settings ---- */}
        <Card padding="lg">
          <CardHeader
            title="Digest settings"
            subtitle="Comma-separated recipients per digest. All three go to Mitchell until changed here."
            icon={Mail}
            action={
              <Badge variant={emailOk ? 'success' : 'warning'} dot>
                {emailOk ? `Resend · ${settings?.email.from ?? 'configured'}` : 'Resend not configured'}
              </Badge>
            }
          />

          {!emailOk && (
            <div
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] mb-4"
              style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}
            >
              <AlertTriangle size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--warning)' }} />
              <p className="text-[12.5px]" style={{ color: 'var(--warning)' }}>
                Without <code>RESEND_API_KEY</code> + <code>RESEND_FROM_EMAIL</code> nothing is emailed. Digests are still
                rendered on schedule and archived below, so you can check them before going live.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              label="Daily to-do → Miranda + Jake"
              value={recipients.todo}
              onChange={(e) => setRecipients((r) => ({ ...r, todo: e.target.value }))}
              placeholder="miranda@…, jake@…"
              hint="Every day at 7am (business timezone)."
            />
            <Input
              label="Weekly scorecard → Jake"
              value={recipients.weekly}
              onChange={(e) => setRecipients((r) => ({ ...r, weekly: e.target.value }))}
              placeholder="jake@…"
              hint="Mondays at 7am, covering the Sun–Sat week just ended."
            />
            <Input
              label="Monthly scorecard"
              value={recipients.monthly}
              onChange={(e) => setRecipients((r) => ({ ...r, monthly: e.target.value }))}
              placeholder="jake@…"
              hint="1st of the month at 7am, covering the previous month."
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <Toggle checked={enabled.todo} onChange={(v) => setEnabled((e) => ({ ...e, todo: v }))} label="Daily to-do enabled" description={enabled.todo ? 'Runs on schedule' : 'Skipped by the schedule; Send now still works'} />
            <Toggle checked={enabled.weekly} onChange={(v) => setEnabled((e) => ({ ...e, weekly: v }))} label="Weekly scorecard enabled" description={enabled.weekly ? 'Runs on Mondays' : 'Skipped by the schedule'} />
            <Toggle checked={enabled.monthly} onChange={(v) => setEnabled((e) => ({ ...e, monthly: v }))} label="Monthly scorecard enabled" description={enabled.monthly ? 'Runs on the 1st' : 'Skipped by the schedule'} />
          </div>
          <div className="mt-3">
            <Button variant="primary" icon={Save} loading={busy === 'save'} onClick={saveRecipients}>
              Save digest settings
            </Button>
          </div>
        </Card>

        {/* ---- Preview + send ---- */}
        <Card padding="lg">
          <CardHeader
            title="Preview & send"
            subtitle="Previews render live from the same metrics engine as the Command Center. Send now forces a send even if the period is empty."
            icon={Eye}
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {KINDS.map((k) => (
              <div
                key={k.kind}
                className="px-3 py-3 rounded-[8px]"
                style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {k.label}
                </div>
                <div className="text-[11.5px] mb-3" style={{ color: 'var(--text-quaternary)' }}>
                  {k.schedule}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button icon={Eye} onClick={() => openPreview(k.kind, k.label)}>
                    Preview
                  </Button>
                  <Button variant="primary" icon={Send} loading={busy === `send:${k.kind}`} onClick={() => sendNow(k.kind, k.label)}>
                    Send now
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {preview && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                  {preview.title}
                </span>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Close
                </Button>
              </div>
              <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: '#f3f4f6' }}>
                <iframe
                  title={preview.title}
                  src={preview.src}
                  srcDoc={preview.html}
                  sandbox=""
                  className="w-full"
                  style={{ height: 720, border: 0, background: '#f3f4f6' }}
                />
              </div>
            </div>
          )}
        </Card>

        {/* ---- Archive ---- */}
        <Card padding="lg">
          <CardHeader
            title="Archive"
            subtitle="Every digest the schedule produced, sent or not. Click a row to open it."
            icon={Archive}
            action={
              <Badge variant="neutral" size="xs">
                {digests.length} digest{digests.length === 1 ? '' : 's'}
              </Badge>
            }
          />
          {digests.length === 0 ? (
            <EmptyState
              icon={<Mail size={18} />}
              title="No digests yet"
              description="The first one appears after the 7am cron runs, or when you press Send now above."
            />
          ) : (
            <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr style={{ background: 'var(--surface-sunken)' }}>
                    {['Created', 'Digest', 'Period', 'Recipients', 'Status', 'Subject'].map((h) => (
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
                  {digests.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => openArchived(d)}
                      className="cursor-pointer transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderTop: '1px solid var(--border-subtle)' }}
                    >
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                        {fmt(d.createdAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{KINDS.find((k) => k.kind === d.kind)?.label ?? d.kind}</td>
                      <td className="px-3 py-2 whitespace-nowrap tabular">
                        {d.periodStart === d.periodEnd ? d.periodStart : `${d.periodStart} → ${d.periodEnd}`}
                      </td>
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
