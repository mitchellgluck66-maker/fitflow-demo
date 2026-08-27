'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Badge } from './Badge';
import { EmptyState } from './PageHeader';
import { formatCents, type PaymentDetail } from '@/lib/metrics';
import { addDays, formatRangeLabel } from '@/lib/dates';

const STATUS_VARIANT: Record<string, 'positive' | 'negative' | 'warning' | 'info' | 'neutral'> = {
  succeeded: 'positive',
  failed: 'negative',
  refunded: 'negative',
  pending: 'info',
};

const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap';

function fmtDate(on: string | null): string {
  if (!on) return '—';
  const [y, m, d] = on.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

const Row: React.FC<{ p: PaymentDetail }> = ({ p }) => {
  const failed = p.status === 'failed';
  return (
    <tr style={{ borderTop: '1px solid var(--border-subtle)', background: failed ? 'var(--negative-muted)' : undefined }}>
      <td className="px-3 py-2.5 whitespace-nowrap tabular" style={{ color: 'var(--text-secondary)' }}>
        {fmtDate(p.on)}
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
          {p.customerName ?? p.email ?? '—'}
        </div>
        {p.customerName && p.email && (
          <div className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
            {p.email}
          </div>
        )}
        {p.description && (
          <div className="text-[11.5px] truncate max-w-[260px]" style={{ color: 'var(--text-quaternary)' }}>
            {p.description}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        <Badge variant="neutral" size="xs">
          {p.kind === 'invoice' ? 'recurring' : p.kind}
        </Badge>
      </td>
      <td className="px-3 py-2.5 text-right tabular">
        <span className="font-semibold" style={{ color: 'var(--text-primary)', textDecoration: p.refundedCents >= p.amountCents && p.amountCents > 0 ? 'line-through' : undefined }}>
          {formatCents(p.amountCents)}
        </span>
        {p.refundedCents > 0 && (
          <div className="text-[11px]" style={{ color: 'var(--warning)' }}>
            −{formatCents(p.refundedCents)} refunded
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        <Badge variant={STATUS_VARIANT[p.status] ?? 'neutral'} size="xs">
          {p.status}
        </Badge>
      </td>
      <td className="px-3 py-2.5">
        {p.contactId ? (
          <>
            <div style={{ color: 'var(--text-primary)' }}>
              <Link href={`/clients/${p.contactId}`} className="font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>
                {p.contactName ?? 'Matched contact'}
              </Link>
              {p.matchSource === 'manual' && (
                <span className="ml-1.5">
                  <Badge variant="accent" size="xs">
                    manual match
                  </Badge>
                </span>
              )}
            </div>
            <div className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
              {p.source ?? 'Unknown source'}
              {p.cohortWeek && p.status === 'succeeded' && ` · Cohort: week of ${formatRangeLabel(p.cohortWeek, addDays(p.cohortWeek, 6))}`}
            </div>
          </>
        ) : (
          <Link href="/setup" className="text-[12px]" style={{ color: 'var(--text-quaternary)' }}>
            unmatched · resolve in Setup →
          </Link>
        )}
      </td>
    </tr>
  );
};

/** Payments in the period, failed ones pinned at the top so nobody misses them. */
export const PaymentsTable: React.FC<{ payments: PaymentDetail[]; unmatchedCount: number }> = ({ payments, unmatchedCount }) => {
  if (payments.length === 0) {
    return <EmptyState title="No payments in this period" description="Stripe is connected; nothing was charged in the selected dates." />;
  }
  const failed = payments.filter((p) => p.status === 'failed');
  const rest = payments.filter((p) => p.status !== 'failed');

  return (
    <div className="space-y-3">
      {unmatchedCount > 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          {unmatchedCount} successful payment{unmatchedCount === 1 ? '' : 's'} could not be matched to a contact by email or phone —{' '}
          <Link href="/setup" style={{ color: 'var(--accent)' }}>
            match them in Setup → Sync health
          </Link>
          .
        </p>
      )}
      <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ background: 'var(--surface-sunken)' }}>
              {['Date', 'Customer', 'Kind', 'Amount', 'Status', 'Matched contact'].map((h, i) => (
                <th key={h} className={`${th} ${i === 3 ? 'text-right' : ''}`} style={{ color: 'var(--text-quaternary)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {failed.length > 0 && (
              <>
                <tr>
                  <td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--negative-text)', background: 'var(--negative-muted)' }}>
                    <span className="inline-flex items-center gap-1.5">
                      <AlertTriangle size={12} strokeWidth={2.4} /> Needs attention · {failed.length} failed
                    </span>
                  </td>
                </tr>
                {failed.map((p) => (
                  <Row key={p.id} p={p} />
                ))}
                <tr>
                  <td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)', background: 'var(--surface-sunken)' }}>
                    All payments
                  </td>
                </tr>
              </>
            )}
            {rest.map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
