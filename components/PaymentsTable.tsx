'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Badge } from './Badge';
import { EmptyState } from './PageHeader';
import { FilterBar, NoMatches } from './FilterBar';
import { SortableHeader } from './SortableHeader';
import { useTableState, applyClient, facetOptions } from './useTableState';
import { formatCents, type PaymentDetail } from '@/lib/metrics';
import { addDays, formatRangeLabel } from '@/lib/dates';

const STATUS_VARIANT: Record<string, 'positive' | 'negative' | 'warning' | 'info' | 'neutral'> = {
  succeeded: 'positive',
  failed: 'negative',
  refunded: 'negative',
  pending: 'info',
};

const FACETS = ['status', 'kind', 'source', 'matched'];

const th = { color: 'var(--text-quaternary)' };

function fmtDate(on: string | null): string {
  if (!on) return '—';
  const [y, m, d] = on.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

const kindLabel = (k: string) => (k === 'invoice' ? 'recurring' : k);

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
          {kindLabel(p.kind)}
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
              <Link href={`/clients/${p.contactId}`} className="font-medium hover:underline focus-ring rounded" style={{ color: 'var(--text-primary)' }}>
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

/**
 * Payments in the period. Failed payments stay pinned at the top regardless
 * of sort (sort applies within each group). Filter/sort/search state lives
 * in the URL under the `p_` prefix.
 */
export const PaymentsTable: React.FC<{ payments: PaymentDetail[]; unmatchedCount: number }> = ({ payments, unmatchedCount }) => {
  const t = useTableState({ prefix: 'p_', facetKeys: FACETS });

  const rows = useMemo(
    () =>
      applyClient(payments, t.state, {
        search: [(p) => p.customerName, (p) => p.email, (p) => p.description, (p) => p.contactName, (p) => p.stripeId],
        facets: {
          status: (p) => p.status,
          kind: (p) => kindLabel(p.kind),
          source: (p) => p.source ?? 'Unknown',
          matched: (p) => (p.contactId ? 'matched' : 'unmatched'),
        },
        sorts: {
          date: (p) => p.on,
          amount: (p) => p.amountCents,
          customer: (p) => p.customerName ?? p.email,
          status: (p) => p.status,
        },
        defaultSort: { key: 'date', dir: 'desc' },
      }),
    [payments, t.state],
  );

  if (payments.length === 0) {
    return <EmptyState title="No payments in this period" description="Stripe is connected; nothing was charged in the selected dates." />;
  }

  const failed = rows.filter((p) => p.status === 'failed');
  const rest = rows.filter((p) => p.status !== 'failed');
  const activeSort = t.state.sort ?? 'date';
  const dir = t.state.sort ? t.state.dir : 'desc';

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

      <FilterBar
        state={t.state}
        facets={[
          { key: 'status', label: 'Status', options: facetOptions(payments, (p) => p.status) },
          { key: 'kind', label: 'Kind', options: facetOptions(payments, (p) => kindLabel(p.kind)) },
          { key: 'source', label: 'Source', options: facetOptions(payments, (p) => p.source ?? 'Unknown') },
          { key: 'matched', label: 'Matched', options: facetOptions(payments, (p) => (p.contactId ? 'matched' : 'unmatched')) },
        ]}
        onQ={t.setQ}
        onToggle={t.toggleFilter}
        onClear={t.clearFilters}
        shown={rows.length}
        total={payments.length}
        placeholder="Search customer, email, description…"
        noun="payments"
      />

      {rows.length === 0 ? (
        <NoMatches onClear={t.clearFilters} noun="payments" />
      ) : (
        <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                <SortableHeader label="Date" sortKey="date" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                <SortableHeader label="Customer" sortKey="customer" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={th}>
                  Kind
                </th>
                <SortableHeader label="Amount" sortKey="amount" activeKey={activeSort} dir={dir} onSort={t.setSort} align="right" style={th} />
                <SortableHeader label="Status" sortKey="status" activeKey={activeSort} dir={dir} onSort={t.setSort} style={th} />
                <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={th}>
                  Matched contact
                </th>
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
                  {rest.length > 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-quaternary)', background: 'var(--surface-sunken)' }}>
                        All payments
                      </td>
                    </tr>
                  )}
                </>
              )}
              {rest.map((p) => (
                <Row key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
