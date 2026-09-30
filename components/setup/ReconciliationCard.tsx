'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { GitCompareArrows, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { AccordionCard, Badge, Button, PeopleDrawer, Toast } from '@/components';
import { FetchError } from '@/components/FetchError';
import { fetchJson } from '@/lib/clientFetch';

interface Person {
  name: string;
  on: string;
  reason: string;
  pipeline: string | null;
  contactId: string | null;
  link: string | null;
  alsoInFollowed: boolean;
  contactDateUnverified: boolean;
}
interface ClassRow {
  label: string;
  count: number;
  unverified: number;
  currentCount: number;
  candidateCount: number;
  candidateWouldCount: boolean | null;
  people: Person[];
}
interface Payload {
  today: string;
  timezone: string;
  summary: { ranAt: string; through: string; rows: number } | null;
  ledger: {
    week: { start: string; end: string; label: string; isLastComplete: boolean };
    canStepForward: boolean;
    byClass: Record<string, ClassRow>;
    current: number;
    currentLabel: string;
    candidate: number;
    candidateLabel: string;
    otherPipelines: number;
    unresolved: number;
    sampleExcluded: number;
    mirrorAsOf: string | null;
    trackedAsOf: string | null;
    ranAt: string | null;
    stale: boolean;
    error: string | null;
    ledgerVersion: string;
    note: string;
  };
  ratio: {
    through: string;
    metaDayTz: string;
    businessTz: string;
    unmatchedUtmRows: number;
    fetchedDays: number;
    errors: string[];
    metaAsOf: string | null;
    campaigns: Array<{ campaignId: string; campaignName: string; verdict: { state: string; rolling7: number | null; baseline: number | null; meta7: number; fitflow7: number; text: string }; days: Array<{ date: string; meta: number | null; fitflow: number }> }>;
  } | null;
}

const CLASS_ORDER = ['A1', 'A2', 'U', 'A3', 'C', 'D', 'M', 'P', 'S', 'X', 'XN', 'unresolved'];
const STATE_BADGE: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  stable: { variant: 'success', label: 'stable' },
  drift_up: { variant: 'warning', label: 'drift ↑' },
  drift_down: { variant: 'warning', label: 'drift ↓' },
  broken_meta: { variant: 'danger', label: 'broken — Meta only' },
  broken_fitflow: { variant: 'danger', label: 'broken — FitFlow only' },
  insufficient: { variant: 'neutral', label: 'too small' },
  learning: { variant: 'neutral', label: 'learning' },
  incomplete: { variant: 'warning', label: 'incomplete' },
};
const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000))} h ago` : 'never');
const x = (r: number | null) => (r === null ? '—' : `${r.toFixed(2)}×`);
const shiftWeek = (sunday: string, weeks: number) => {
  const [y, m, d] = sunday.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return t.toISOString().slice(0, 10);
};

/**
 * Setup → Reconciliation (plan item 4): the Applied ledger for one Sun–Sat week under BOTH
 * definitions (the candidate labelled "deferred #1, not in use"), the people behind each class one
 * click away, and the Meta-to-FitFlow ratio per campaign with its state. Reconcile now runs both.
 */
export const ReconciliationCard: React.FC = () => {
  const [week, setWeek] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async (w: string | null) => {
    try {
      setData(await fetchJson<Payload>(`/api/reconciliation${w ? `?week=${w}` : ''}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load(week);
  }, [week, load]);

  const reconcileNow = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/reconciliation', { method: 'POST' });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; ledger?: { reason?: string | null; skipped?: string | null }; ratio?: { reason?: string | null; skipped?: string | null; notConfigured?: boolean } | null; error?: string };
      const detail = [d.ledger ? `ledger: ${d.ledger.skipped ?? d.ledger.reason ?? ''}` : null, d.ratio ? `ratio: ${d.ratio.notConfigured ? 'Meta not connected' : (d.ratio.skipped ?? d.ratio.reason ?? '')}` : null, d.error ?? null].filter(Boolean).join(' · ');
      setToast({ message: d.ok ? 'Reconciled' : 'Reconcile failed', detail, type: d.ok ? 'success' : 'error' });
      await load(week);
    } finally {
      setBusy(false);
    }
  };

  const L = data?.ledger;
  const summary = !data ? (error ? 'Could not load' : 'Loading…') : !data.summary ? 'Not reconciled yet' : `${L!.week.label}: ${L!.current} counted · ${L!.candidate} form applicants${data.ratio?.campaigns.length ? ` · Meta ${data.ratio.campaigns.map((c) => c.verdict.state).includes('stable') ? x(data.ratio.campaigns.find((c) => c.verdict.state === 'stable')!.verdict.rolling7) : data.ratio.campaigns[0].verdict.state}` : ''}`;
  const drifting = data?.ratio?.campaigns.filter((c) => ['drift_up', 'drift_down', 'broken_meta', 'broken_fitflow'].includes(c.verdict.state)) ?? [];
  const openRow = open && L ? L.byClass[open] : null;

  return (
    <AccordionCard
      title="Reconciliation"
      summary={summary}
      subtitle="Applied, every day, under both definitions: who is counted and why, applicants in other pipelines, and Meta's application count against FitFlow's per campaign"
      icon={GitCompareArrows}
      defaultOpen={Boolean(data && (!data.summary || L?.error || drifting.length > 0 || (L?.unresolved ?? 0) > 0))}
      action={<Badge variant={!data?.summary ? 'neutral' : L?.error || drifting.length ? 'warning' : 'success'} dot>{!data?.summary ? 'Not run' : L?.error ? 'Failed' : drifting.length ? `${drifting.length} drifting` : 'Reconciled'}</Badge>}
    >
      {error && <FetchError title="Could not load the reconciliation" error={error} onRetry={() => void load(week)} />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-[12.5px]" style={{ color: L?.error ? 'var(--warning)' : 'var(--text-secondary)' }}>
              {L?.error ? (
                <>
                  Last run failed: <strong>{L.error}</strong> — showing the ledger computed {ago(L.ranAt)} (stale)
                </>
              ) : data.summary ? (
                <>
                  Ledger computed <strong>{ago(L!.ranAt)}</strong>
                  {L!.stale ? ' (not yet today)' : ''} · mirror of other pipelines as of <strong>{ago(L!.mirrorAsOf)}</strong> · followed pipeline as of <strong>{ago(L!.trackedAsOf)}</strong>
                  {L!.sampleExcluded ? ` · ${L!.sampleExcluded} sample rows excluded` : ''}
                </>
              ) : (
                'Not reconciled yet — the daily dispatch builds the ledger after the GoHighLevel sync.'
              )}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" icon={RefreshCw} loading={busy} onClick={reconcileNow}>
              Reconcile now
            </Button>
          </div>
          <p className="text-[12px] mb-3" style={{ color: 'var(--warning)' }} data-testid="reconciliation-note">
            {L!.note}. Counts on the dashboard use the current definition; the candidate column shows what deferred #1 would count and is not in use.
          </p>

          {/* Week */}
          <div className="flex items-center gap-2 mb-2">
            <Button variant="ghost" icon={ChevronLeft} onClick={() => setWeek(shiftWeek(L!.week.start, -1))} aria-label="Previous week" />
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              Week of {L!.week.label}
              {L!.week.isLastComplete ? ' · last complete week' : ''}
            </span>
            <Button variant="ghost" icon={ChevronRight} disabled={!L!.canStepForward} onClick={() => setWeek(shiftWeek(L!.week.start, 1))} aria-label="Next week" />
            <div className="flex-1" />
            <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="reconciliation-totals">
              <strong>{L!.current}</strong> {L!.currentLabel} · <strong>{L!.candidate}</strong> {L!.candidateLabel} · {L!.otherPipelines} in other pipelines
              {L!.unresolved ? <strong style={{ color: 'var(--warning)' }}> · {L!.unresolved} unresolved</strong> : null}
            </span>
          </div>
          <table className="w-full text-[12.5px] mb-5" style={{ color: 'var(--text-secondary)' }}>
            <thead>
              <tr style={{ color: 'var(--text-tertiary)' }}>
                <th className="text-left font-medium py-1">Class</th>
                <th className="text-right font-medium py-1">People</th>
                <th className="text-right font-medium py-1">Counted today</th>
                <th className="text-right font-medium py-1">Candidate (deferred #1, not in use)</th>
              </tr>
            </thead>
            <tbody>
              {CLASS_ORDER.filter((k) => L!.byClass[k] && (L!.byClass[k].count > 0 || ['A1', 'A2', 'A3', 'C', 'D', 'X'].includes(k))).map((k) => {
                const r = L!.byClass[k];
                return (
                  <tr key={k} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="py-1.5">
                      <span style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--text-primary)' }}>{k}</span> <span>{r.label}</span>
                      {k === 'A1' && r.unverified > 0 && <span style={{ color: 'var(--warning)' }}> · {r.unverified} contact date unverified</span>}
                      {k === 'U' && r.count > 0 && <span style={{ color: 'var(--warning)' }}> · counted as form applicants; first stage unknown</span>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button type="button" className="underline decoration-dotted focus-ring" disabled={r.count === 0} onClick={() => setOpen(k)} style={{ color: r.count ? 'var(--accent)' : 'var(--text-quaternary)' }} data-testid={`class-${k}`}>
                        {r.count}
                      </button>
                    </td>
                    <td className="py-1.5 text-right">{k === 'unresolved' ? '?' : r.currentCount}</td>
                    <td className="py-1.5 text-right">{k === 'unresolved' ? '?' : r.candidateCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Ratio */}
          <div className="text-[12.5px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            Meta "Website Submit Applications" vs FitFlow applications, per campaign (last 7 days)
          </div>
          {!data.ratio ? (
            <p className="text-[12px] mb-2" style={{ color: 'var(--text-quaternary)' }}>
              Not run yet — needs Meta connected and the ledger. The Meta sync records the account timezone first.
            </p>
          ) : (
            <>
              <p className="text-[11.5px] mb-2" style={{ color: 'var(--text-quaternary)' }}>
                Meta days are {data.ratio.metaDayTz}; FitFlow days are {data.ratio.businessTz}. Through {data.ratio.through} · Meta as of {ago(data.ratio.metaAsOf)}
                {data.ratio.unmatchedUtmRows ? ` · ${data.ratio.unmatchedUtmRows} counted applications match no Meta campaign (utm)` : ''}
                {data.ratio.errors.length ? ` · ${data.ratio.errors.length} fetch error(s): ${data.ratio.errors[0]}` : ''}
              </p>
              <table className="w-full text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-tertiary)' }}>
                    <th className="text-left font-medium py-1">Campaign</th>
                    <th className="text-right font-medium py-1">Meta 7d</th>
                    <th className="text-right font-medium py-1">FitFlow 7d</th>
                    <th className="text-right font-medium py-1">Ratio</th>
                    <th className="text-right font-medium py-1">Baseline 28d</th>
                    <th className="text-right font-medium py-1">State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ratio.campaigns.map((c) => {
                    const b = STATE_BADGE[c.verdict.state] ?? { variant: 'neutral' as const, label: c.verdict.state };
                    return (
                      <tr key={c.campaignId} style={{ borderTop: '1px solid var(--border-subtle)' }} title={c.verdict.text} data-testid={`ratio-${c.campaignId}`}>
                        <td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                          {c.campaignName}
                          <div className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                            {c.days.map((d) => `${d.date.slice(5)} ${d.meta === null ? '?' : d.meta}/${d.fitflow}`).join(' · ')}
                          </div>
                        </td>
                        <td className="py-1.5 text-right">{c.verdict.meta7}</td>
                        <td className="py-1.5 text-right">{c.verdict.fitflow7}</td>
                        <td className="py-1.5 text-right">{x(c.verdict.rolling7)}</td>
                        <td className="py-1.5 text-right">{x(c.verdict.baseline)}</td>
                        <td className="py-1.5 text-right">
                          <Badge variant={b.variant} size="xs">
                            {b.label}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <PeopleDrawer
        open={openRow !== null}
        onClose={() => setOpen(null)}
        title={openRow && open ? `${open} · ${openRow.label} · ${openRow.count}` : ''}
        subtitle={openRow ? `${L?.week.label} · ${openRow.people.filter((p) => !p.contactId).length ? `${openRow.people.filter((p) => !p.contactId).length} not mirrored yet · ` : ''}${openRow.people[0]?.reason ?? ''}` : undefined}
        contactIds={openRow ? openRow.people.map((p) => p.contactId).filter((id): id is string => Boolean(id)) : []}
      />
      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
