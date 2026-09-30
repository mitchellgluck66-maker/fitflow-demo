'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { AppliedCaveat, InputHealth, MarketingMetrics, Revenue } from '@/lib/metrics';
import { formatCents } from '@/lib/metrics';

/**
 * Data-health notices for the marketing metrics (CLAUDE.md: never present a
 * computed number when its inputs are missing — show the warning instead).
 * Renders nothing when everything is classified, matched and valued.
 */
export function marketingWarnings(m: MarketingMetrics, r: Revenue): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (m.contractValueMissing.length > 0) {
    out.push(
      <span key="ltv">
        <strong>LTV:CAC withheld</strong> — {m.contractValueMissing.length} new client{m.contractValueMissing.length === 1 ? ' has' : 's have'} no contract value on
        the GoHighLevel opportunity:{' '}
        {m.contractValueMissing.slice(0, 6).map((p, i) => (
          <React.Fragment key={p.contactId}>
            {i > 0 && ', '}
            <Link href={`/clients/${p.contactId}`} className="underline">
              {p.name}
            </Link>
          </React.Fragment>
        ))}
        {m.contractValueMissing.length > 6 && ` and ${m.contractValueMissing.length - 6} more`}. Set the opportunity value in GHL; it appears on the next sync.
      </span>,
    );
  }
  if (m.unattributedEnrollments > 0) {
    out.push(
      <span key="att">
        <strong>{m.unattributedEnrollments} enrollment{m.unattributedEnrollments === 1 ? '' : 's'}</strong> ha{m.unattributedEnrollments === 1 ? 's' : 've'} no paid/organic
        class and {m.unattributedEnrollments === 1 ? 'is' : 'are'} excluded from Paid CAC (still in Blended CAC). Run <code>npm run reclassify:attribution</code>.
      </span>,
    );
  }
  if (m.unattributedInitialCount > 0) {
    out.push(
      <span key="cash">
        <strong>{formatCents(m.unattributedInitialCents, m.currency)}</strong> of initial cash ({m.unattributedInitialCount} payment{m.unattributedInitialCount === 1 ? '' : 's'}) is not
        matched to a classified contact and is excluded from ROAS —{' '}
        <Link href="/setup" className="underline">
          match payments in Setup → Sync health
        </Link>
        .
      </span>,
    );
  }
  if (r.unclassifiedCount > 0) {
    out.push(
      <span key="cls">
        <strong>{r.unclassifiedCount} succeeded payment{r.unclassifiedCount === 1 ? '' : 's'}</strong> ({formatCents(r.unclassifiedCents, r.currency)}) ha{r.unclassifiedCount === 1 ? 's' : 've'}{' '}
        no payment class and {r.unclassifiedCount === 1 ? 'is' : 'are'} excluded from initial cash. Run <code>npm run reclassify:payments</code>.
      </span>,
    );
  }
  return out;
}

/** F14 (2026-09-30): applicants are dated by their application — the ones we could not date are named, not guessed. */
export function inputWarnings(h: InputHealth | undefined | null): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (h && h.applicantsWithoutDate.length > 0) {
    out.push(
      <span key="applied-date">
        <strong>{h.applicantsWithoutDate.length} contact{h.applicantsWithoutDate.length === 1 ? '' : 's'}</strong> in the followed pipeline ha
        {h.applicantsWithoutDate.length === 1 ? 's' : 've'} no application date and {h.applicantsWithoutDate.length === 1 ? 'is' : 'are'} not counted as applied:{' '}
        {h.applicantsWithoutDate.slice(0, 5).map((p, i) => (
          <React.Fragment key={p.contactId}>
            {i > 0 && ', '}
            <Link href={`/clients/${p.contactId}`} className="underline">
              {p.name}
            </Link>
          </React.Fragment>
        ))}
        {h.applicantsWithoutDate.length > 5 && ` and ${h.applicantsWithoutDate.length - 5} more`}. FitFlow has no opportunity record for them in the followed pipeline yet; the next
        sync re-reads {h.applicantsWithoutDate.length === 1 ? 'it' : 'them'}.
      </span>,
    );
  }
  if (h && h.appliedFromMove > 0) {
    out.push(
      <span key="applied-move">
        <strong>{h.appliedFromMove} application{h.appliedFromMove === 1 ? '' : 's'}</strong> moved in from another pipeline — dated by entry into the followed pipeline.
      </span>,
    );
  }
  return out;
}

/** Names, first five linked, then "and N more" — the people are one click away. */
const NameList: React.FC<{ people: Array<{ contactId: string; name: string; title?: string }> }> = ({ people }) => (
  <>
    {people.slice(0, 5).map((p, i) => (
      <React.Fragment key={p.contactId}>
        {i > 0 && ', '}
        <Link href={`/clients/${p.contactId}`} className="underline" title={p.title}>
          {p.name}
        </Link>
      </React.Fragment>
    ))}
    {people.length > 5 && ` and ${people.length - 5} more`}
  </>
);

/**
 * The Applied caveat (2026-09-30): the definition of Applied is under review (docs/deferred.md #1). Until it is
 * decided, every Applied number says how many rows have no application-form record and how many form applicants
 * landed in other pipelines — with the people one click away. Nothing is changed or hidden.
 */
export function appliedCaveatWarnings(c: AppliedCaveat | undefined | null): React.ReactNode[] {
  if (!c || (c.withoutFormRecord.length === 0 && c.otherPipelines.length === 0)) return [];
  return [
    <span key="applied-caveat">
      <strong>Applied {c.applied}</strong> · definition under review.
      {c.withoutFormRecord.length > 0 && (
        <>
          {' '}
          <strong>{c.withoutFormRecord.length}</strong> {c.withoutFormRecord.length === 1 ? 'has' : 'have'} no application form record (manual entries or non-form contacts):{' '}
          <NameList people={c.withoutFormRecord.map((p) => ({ contactId: p.contactId, name: p.name, title: p.reason }))} />.
        </>
      )}
      {c.otherPipelines.length > 0 && (
        <>
          {' '}
          <strong>{c.otherPipelines.length}</strong> form applicant{c.otherPipelines.length === 1 ? '' : 's'} landed in other pipelines and {c.otherPipelines.length === 1 ? 'is' : 'are'} not counted:{' '}
          <NameList people={c.otherPipelines.map((p) => ({ contactId: p.contactId, name: p.name, title: `${p.pipeline}${p.alsoInFollowed ? ' · also has an application in the followed pipeline' : ''}` }))} />.
        </>
      )}
    </span>,
  ];
}

export const DataHealthNotice: React.FC<{ items: React.ReactNode[] }> = ({ items }) => {
  if (items.length === 0) return null;
  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-[10px]"
      style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}
      role="status"
    >
      <AlertTriangle size={14} strokeWidth={2.3} className="mt-[3px] shrink-0" style={{ color: 'var(--warning)' }} />
      <ul className="text-[12.5px] leading-snug space-y-1" style={{ color: 'var(--warning)' }}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
};
