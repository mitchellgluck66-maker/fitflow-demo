'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, User, GitBranch, History, Eye, Megaphone } from 'lucide-react';
import { Card, CardHeader, PageHeader, PageBody, EmptyState, Badge, Button, Skeleton, SkeletonText, SkeletonTable, Select } from '@/components';
import { ClientTimeline } from '@/components/ClientTimeline';
import type { ClientProfile } from '@/lib/queries/clients';

function roleVariant(role: string | null): 'success' | 'danger' | 'neutral' | 'accent' {
  if (role === 'enrolled') return 'success';
  if (role === 'consult_noshow' || role === 'roadmap_noshow' || role === 'consult_rescheduled' || role === 'roadmap_rescheduled') return 'danger';
  if (role === 'consult_booked' || role === 'roadmap_booked' || role === 'roadmap_showed') return 'accent';
  return 'neutral';
}

function days(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
    <span className="w-28 shrink-0 text-[11.5px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-quaternary)' }}>
      {label}
    </span>
    <span className="text-[13px] min-w-0 break-words" style={{ color: 'var(--text-primary)' }}>
      {value ?? <span style={{ color: 'var(--text-quaternary)' }}>—</span>}
    </span>
  </div>
);

export default function ClientProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const setAttribution = async (value: 'paid' | 'organic' | null) => {
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      const res = await fetch(`/api/clients/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributionClass: value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
      setProfile((p) => (p ? { ...p, attributionClass: body.attributionClass, attributionReason: body.reason, attributionClassSource: body.source } : p));
    } catch (e) {
      setOverrideError(e instanceof Error ? e.message : String(e));
    } finally {
      setOverrideBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${id}`)
      .then(async (r) => {
        if (r.status === 404) return { missing: true as const };
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
        return body as ClientProfile;
      })
      .then((res) => {
        if (cancelled) return;
        if ('missing' in res) setStatus('missing');
        else {
          setProfile(res);
          setStatus('ok');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (status === 'loading') {
    return (
      <>
        <PageHeader title="Client" description="Loading profile…" />
        <PageBody className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card padding="lg">
              <Skeleton className="h-3 w-24 mb-4" />
              <SkeletonText lines={5} />
            </Card>
            <Card padding="lg">
              <Skeleton className="h-3 w-32 mb-4" />
              <SkeletonText lines={4} />
            </Card>
          </div>
          <Card padding="lg">
            <Skeleton className="h-3 w-28 mb-4" />
            <SkeletonTable rows={6} cols={3} />
          </Card>
        </PageBody>
      </>
    );
  }

  if (status !== 'ok' || !profile) {
    return (
      <>
        <PageHeader title="Client" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<User size={18} />}
              title={status === 'missing' ? 'No such client' : 'Could not load this client'}
              description={status === 'missing' ? 'This id is not in FitFlow. It may have been removed from GoHighLevel.' : (error ?? undefined)}
              action={
                <Link href="/clients">
                  <Button icon={ArrowLeft}>All clients</Button>
                </Link>
              }
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const ghlDisabledReason = profile.origin === 'demo' ? 'Sample data has no GoHighLevel record' : !profile.ghlUrl ? 'Add the GoHighLevel Location ID in Setup to enable deep links' : null;

  return (
    <>
      <PageHeader
        title={profile.name}
        description={[profile.pipelineName, profile.stageName].filter(Boolean).join(' · ') || 'Client profile'}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/clients">
              <Button variant="ghost" icon={ArrowLeft}>
                All clients
              </Button>
            </Link>
            {profile.ghlUrl && !ghlDisabledReason ? (
              <a href={profile.ghlUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="primary" iconRight={ExternalLink}>
                  Open in GoHighLevel
                </Button>
              </a>
            ) : (
              <span title={ghlDisabledReason ?? undefined}>
                <Button variant="primary" iconRight={ExternalLink} disabled>
                  Open in GoHighLevel
                </Button>
              </span>
            )}
          </div>
        }
      />

      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {profile.stageName && (
            <Badge variant={roleVariant(profile.stageRole)} dot>
              {profile.stageName}
            </Badge>
          )}
          {profile.source && <Badge variant="neutral">{profile.source}</Badge>}
          {profile.attributionClass && (
            <Badge variant={profile.attributionClass === 'paid' ? 'accent' : 'neutral'} dot>
              {profile.attributionClass}
              {profile.attributionClassSource === 'manual' ? ' · manual' : ''}
            </Badge>
          )}
          {profile.origin === 'demo' && (
            <Badge variant="warning" size="xs">
              sample
            </Badge>
          )}
        </div>
        <div
          className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px]"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
        >
          <Eye size={14} strokeWidth={2.3} className="mt-px shrink-0" style={{ color: 'var(--text-tertiary)' }} />
          <p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            Everything here is observed from GoHighLevel and Stripe. The only FitFlow-local field is the paid/organic override below; nothing is written back.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card padding="lg">
            <CardHeader title="Identity" icon={User} />
            <Row label="Email" value={profile.email ? <a href={`mailto:${profile.email}`} className="hover:underline">{profile.email}</a> : null} />
            <Row label="Phone" value={profile.phone ? <a href={`tel:${profile.phone}`} className="hover:underline">{profile.phone}</a> : null} />
            <Row label="Source" value={profile.source} />
            <Row
              label="UTM"
              value={
                profile.utmSource || profile.utmMedium || profile.utmCampaign || profile.utmContent
                  ? [profile.utmSource, profile.utmMedium, profile.utmCampaign, profile.utmContent].filter(Boolean).join(' / ')
                  : null
              }
            />
            <Row label="Entry funnel" value={profile.entryFunnel} />
            <Row label="Owner" value={profile.owner} />
            <Row
              label="Tags"
              value={
                profile.tags.length ? (
                  <span className="flex flex-wrap gap-1">
                    {profile.tags.map((t) => (
                      <Badge key={t} variant="neutral" size="xs">
                        {t}
                      </Badge>
                    ))}
                  </span>
                ) : null
              }
            />
            <Row label="GHL id" value={<code className="text-[11.5px]" style={{ fontFamily: 'var(--font-jetbrains)' }}>{profile.ghlContactId}</code>} />
          </Card>

          <Card padding="lg">
            <CardHeader title="Pipeline position" icon={GitBranch} />
            <Row
              label="Stage"
              value={
                profile.stageName ? (
                  <Badge variant={roleVariant(profile.stageRole)} dot>
                    {profile.stageName}
                  </Badge>
                ) : null
              }
            />
            <Row label="Time in stage" value={<span className="tabular">{days(profile.timeInStageHours)}</span>} />
            <Row label="Entered stage" value={fmtDate(profile.stageEnteredAt)} />
            <Row label="Opportunity" value={profile.opportunityStatus} />
            <Row
              label="Value"
              value={profile.monetaryValueCents ? (profile.monetaryValueCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : null}
            />
            <Row label="Applied" value={fmtDate(profile.appliedAt)} />
            <Row label="Last activity" value={fmtDate(profile.lastActivityAt)} />
          </Card>
        </div>

        {/* ---- Attribution: paid vs organic, with the evidence and a local override ---- */}
        <Card padding="lg">
          <CardHeader
            title="Attribution"
            subtitle="Paid CAC and ROAS count this person only when the class is paid. The reason shows which signal decided it."
            icon={Megaphone}
            action={
              <div className="flex items-center gap-2">
                <Select
                  value={profile.attributionClassSource === 'manual' ? (profile.attributionClass ?? '') : ''}
                  disabled={overrideBusy}
                  onChange={(e) => setAttribution(e.target.value === 'paid' || e.target.value === 'organic' ? e.target.value : null)}
                  aria-label="Attribution override"
                >
                  <option value="">Automatic{profile.attributionClassSource === 'auto' && profile.attributionClass ? ` (${profile.attributionClass})` : ''}</option>
                  <option value="paid">Override: paid</option>
                  <option value="organic">Override: organic</option>
                </Select>
              </div>
            }
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6">
            <div>
              <Row
                label="Class"
                value={
                  profile.attributionClass ? (
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={profile.attributionClass === 'paid' ? 'accent' : 'neutral'} dot>
                        {profile.attributionClass}
                      </Badge>
                      <Badge variant={profile.attributionClassSource === 'manual' ? 'warning' : 'success'} size="xs">
                        {profile.attributionClassSource === 'manual' ? 'manual override' : 'auto'}
                      </Badge>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--warning)' }}>not classified — run npm run reclassify:attribution</span>
                  )
                }
              />
              <Row label="Reason" value={profile.attributionReason} />
              {overrideError && <Row label="Error" value={<span style={{ color: 'var(--danger)' }}>{overrideError}</span>} />}
            </div>
            <div>
              <Row label="fbclid" value={profile.fbclid ? <code className="text-[11.5px] break-all" style={{ fontFamily: 'var(--font-jetbrains)' }}>{profile.fbclid}</code> : null} />
              <Row label="gclid" value={profile.gclid ? <code className="text-[11.5px] break-all" style={{ fontFamily: 'var(--font-jetbrains)' }}>{profile.gclid}</code> : null} />
              <Row label="Session source" value={profile.sessionSource} />
              <Row label="Landing URL" value={profile.attributionUrl ? <span className="break-all text-[12px]">{profile.attributionUrl}</span> : null} />
            </div>
          </div>
          <p className="text-[11.5px] mt-3" style={{ color: 'var(--text-quaternary)' }}>
            The override is a FitFlow-only label and survives every sync. Nothing is written to GoHighLevel.
          </p>
        </Card>

        <Card padding="lg">
          <CardHeader title="Timeline" subtitle="Stage moves, appointments and payments — newest first" icon={History} />
          <ClientTimeline items={profile.timeline} />
        </Card>
      </PageBody>
    </>
  );
}
