'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Globe,
  Plug,
  Mail,
  Palette,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Save,
  ExternalLink,
  Monitor,
  Sun,
  Moon,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  Button,
  Badge,
  Toast,
  Select,
  Toggle,
  Input,
  PageHeader,
  PageBody,
  PageLoader,
  useTheme,
} from '@/components';

interface SettingsData {
  timezone: string;
  autoSyncEnabled: boolean;
  summaryRecipientEmail: string;
  lastAutoSyncAt: string | null;
  ghl: {
    configured: boolean;
    dryRun: boolean;
    notifyOnWrite: boolean;
    hasToken: boolean;
    hasLocationId: boolean;
    requiredScopes: string[];
    connection: { ok: boolean; dryRun: boolean; message: string; calendarCount?: number };
  };
  email: { configured: boolean; from: string | null };
  queue: {
    pending: number;
    failed: number;
    succeeded: number;
    dryRun: number;
    isDryRun: boolean;
  };
}

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    detail?: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const { preference, setPreference } = useTheme();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      setData(await res.json());
    } catch {
      setToast({ message: 'Could not load settings', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = (updates: Partial<SettingsData>) => {
    setData((prev) => (prev ? { ...prev, ...updates } : prev));
    setDirty(true);
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: data.timezone,
          autoSyncEnabled: data.autoSyncEnabled,
          summaryRecipientEmail: data.summaryRecipientEmail,
        }),
      });
      if (!res.ok) throw new Error();
      setToast({ message: 'Settings saved', type: 'success' });
      setDirty(false);
    } catch {
      setToast({ message: 'Could not save settings', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const testGhl = async () => {
    setToast({ message: 'Testing connection…', type: 'info' });
    await load();
    setToast({
      message: data?.ghl.connection.ok ? 'Connection OK' : 'Not connected',
      detail: data?.ghl.connection.message,
      type: data?.ghl.connection.ok ? 'success' : 'error',
    });
  };

  if (loading || !data) {
    return (
      <>
        <PageHeader title="Settings" />
        <PageBody>
          <PageLoader />
        </PageBody>
      </>
    );
  }

  const localTime = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: data.timezone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date());
    } catch {
      return '—';
    }
  })();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration for timezone, integrations and delivery."
        actions={
          <Button
            variant="primary"
            icon={Save}
            loading={saving}
            disabled={!dirty}
            onClick={save}
          >
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
        }
      />

      <PageBody className="max-w-3xl space-y-4">
        {/* Appearance */}
        <Card padding="lg">
          <CardHeader
            title="Appearance"
            subtitle="Theme preference for this browser"
            icon={Palette}
          />

          <div
            className="flex items-center gap-1 p-1 rounded-[9px] w-fit"
            style={{
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = preference === option.value;

              return (
                <button
                  key={option.value}
                  onClick={() => setPreference(option.value)}
                  className="flex items-center gap-1.5 h-[30px] px-3 rounded-[7px] text-[12.5px] font-medium transition-all duration-150"
                  style={
                    active
                      ? {
                          background: 'var(--surface)',
                          color: 'var(--text-primary)',
                          boxShadow: 'var(--shadow-xs)',
                        }
                      : { color: 'var(--text-tertiary)' }
                  }
                >
                  <Icon size={13.5} strokeWidth={2.2} />
                  {option.label}
                </button>
              );
            })}
          </div>
        </Card>

        {/* Timezone */}
        <Card padding="lg">
          <CardHeader
            title="Timezone"
            subtitle="Defines the business day for the Today View and the midnight sync"
            icon={Globe}
            action={
              <Badge variant="neutral">
                <span className="tabular">{localTime}</span>
              </Badge>
            }
          />

          <Select
            value={data.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
            hint="Appointments are bucketed into days using this zone, not UTC."
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Card>

        {/* GoHighLevel */}
        <Card padding="lg">
          <CardHeader
            title="GoHighLevel"
            subtitle="Where attendance outcomes are written back"
            icon={Plug}
            action={
              <Badge
                variant={
                  !data.ghl.configured ? 'neutral' : data.ghl.dryRun ? 'warning' : 'success'
                }
                dot
              >
                {!data.ghl.configured
                  ? 'Not configured'
                  : data.ghl.dryRun
                    ? 'Dry run'
                    : 'Live'}
              </Badge>
            }
          />

          <div
            className="flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] mb-4"
            style={{
              background: data.ghl.connection.ok
                ? 'var(--success-muted)'
                : 'var(--warning-muted)',
              border: `1px solid ${data.ghl.connection.ok ? 'var(--success-border)' : 'var(--warning-border)'}`,
            }}
          >
            {data.ghl.connection.ok ? (
              <CheckCircle2
                size={14}
                strokeWidth={2.3}
                className="mt-px shrink-0"
                style={{ color: 'var(--success)' }}
              />
            ) : (
              <AlertTriangle
                size={14}
                strokeWidth={2.3}
                className="mt-px shrink-0"
                style={{ color: 'var(--warning)' }}
              />
            )}
            <p
              className="text-[12.5px] leading-relaxed"
              style={{
                color: data.ghl.connection.ok ? 'var(--success)' : 'var(--warning)',
              }}
            >
              {data.ghl.connection.message}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: 'API token', ok: data.ghl.hasToken },
              { label: 'Location ID', ok: data.ghl.hasLocationId },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between px-3 py-2 rounded-[8px]"
                style={{
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {item.label}
                </span>
                <Badge variant={item.ok ? 'success' : 'neutral'} size="xs">
                  {item.ok ? 'Set' : 'Missing'}
                </Badge>
              </div>
            ))}
          </div>

          {/* Queue state */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {[
              { label: 'Pending', value: data.queue.pending, color: 'var(--info)' },
              { label: 'Previewed', value: data.queue.dryRun, color: 'var(--warning)' },
              { label: 'Synced', value: data.queue.succeeded, color: 'var(--success)' },
              { label: 'Failed', value: data.queue.failed, color: 'var(--danger)' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="px-3 py-2.5 rounded-[8px]"
                style={{
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div
                  className="text-[18px] font-semibold tabular leading-none"
                  style={{ color: stat.color }}
                >
                  {stat.value}
                </div>
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-quaternary)' }}
                >
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          <div className="mb-4">
            <Toggle
              checked={data.autoSyncEnabled}
              onChange={(v) => patch({ autoSyncEnabled: v })}
              label="Midnight auto-sync"
              description="Drain the queue to GoHighLevel automatically at local midnight."
            />
            {data.lastAutoSyncAt && (
              <p
                className="text-[11.5px] mt-2"
                style={{ color: 'var(--text-quaternary)' }}
              >
                Last run: {new Date(data.lastAutoSyncAt).toLocaleString()}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button icon={RefreshCw} onClick={testGhl}>
              Test connection
            </Button>
            <a
              href="https://help.gohighlevel.com/support/solutions/articles/155000003054-private-integrations-everything-you-need-to-know"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="ghost" iconRight={ExternalLink}>
                Create a token
              </Button>
            </a>
          </div>

          {/* Setup instructions */}
          <details className="mt-4 group">
            <summary
              className="text-[12.5px] cursor-pointer select-none list-none flex items-center gap-1.5"
              style={{ color: 'var(--accent)' }}
            >
              How to go live
            </summary>
            <div
              className="mt-3 px-3.5 py-3 rounded-[8px] text-[12px] leading-relaxed"
              style={{
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              <ol className="list-decimal ml-4 space-y-2">
                <li>
                  In GoHighLevel, go to <strong>Settings → Private Integrations</strong>{' '}
                  and create a token. It is shown only once, so copy it immediately.
                </li>
                <li>
                  Grant these scopes:
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {data.ghl.requiredScopes.map((scope) => (
                      <code
                        key={scope}
                        className="px-1.5 py-0.5 rounded-[4px] text-[11px]"
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border-subtle)',
                          fontFamily: 'var(--font-jetbrains)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {scope}
                      </code>
                    ))}
                  </div>
                </li>
                <li>
                  Add <code style={{ fontFamily: 'var(--font-jetbrains)' }}>GHL_API_TOKEN</code>{' '}
                  and{' '}
                  <code style={{ fontFamily: 'var(--font-jetbrains)' }}>GHL_LOCATION_ID</code>{' '}
                  to <code style={{ fontFamily: 'var(--font-jetbrains)' }}>.env.local</code>.
                </li>
                <li>
                  Set{' '}
                  <code style={{ fontFamily: 'var(--font-jetbrains)' }}>GHL_DRY_RUN=false</code>{' '}
                  and restart. Until then every write is queued and previewed but never
                  sent.
                </li>
              </ol>
            </div>
          </details>
        </Card>

        {/* Email delivery */}
        <Card padding="lg">
          <CardHeader
            title="Day summary delivery"
            subtitle="Where the end-of-day recap is sent"
            icon={Mail}
            action={
              <Badge variant={data.email.configured ? 'success' : 'neutral'} dot>
                {data.email.configured ? 'Resend connected' : 'Not configured'}
              </Badge>
            }
          />

          <Input
            label="Default recipient"
            icon={Mail}
            type="email"
            placeholder="name@example.com"
            value={data.summaryRecipientEmail}
            onChange={(e) => patch({ summaryRecipientEmail: e.target.value })}
            hint="Pre-filled in the Export dialog. Sending from the Today View also updates this."
          />

          {!data.email.configured && (
            <div
              className="mt-4 px-3.5 py-3 rounded-[8px] text-[12px] leading-relaxed"
              style={{
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              Add{' '}
              <code style={{ fontFamily: 'var(--font-jetbrains)' }}>RESEND_API_KEY</code>{' '}
              and{' '}
              <code style={{ fontFamily: 'var(--font-jetbrains)' }}>
                RESEND_FROM_EMAIL
              </code>{' '}
              to <code style={{ fontFamily: 'var(--font-jetbrains)' }}>.env.local</code> to
              enable sending. Until then the summary can still be downloaded as CSV.
            </div>
          )}
        </Card>
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
