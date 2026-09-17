'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { MarketingMetrics, Revenue } from '@/lib/metrics';
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
        <strong>{formatCents(m.unattributedInitialCents)}</strong> of initial cash ({m.unattributedInitialCount} payment{m.unattributedInitialCount === 1 ? '' : 's'}) is not
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
        <strong>{r.unclassifiedCount} succeeded payment{r.unclassifiedCount === 1 ? '' : 's'}</strong> ({formatCents(r.unclassifiedCents)}) ha{r.unclassifiedCount === 1 ? 's' : 've'}{' '}
        no payment class and {r.unclassifiedCount === 1 ? 'is' : 'are'} excluded from initial cash. Run <code>npm run reclassify:payments</code>.
      </span>,
    );
  }
  return out;
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
