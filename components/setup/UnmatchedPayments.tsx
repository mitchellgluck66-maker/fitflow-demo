'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, UserX } from 'lucide-react';
import { Badge, Button, Toast } from '@/components';
import { formatCents } from '@/lib/metrics';

interface UnmatchedPayment {
  id: string;
  stripeId: string;
  amountCents: number;
  email: string | null;
  customerName: string | null;
  on: string | null;
}

interface Candidate {
  id: string;
  name: string;
  email: string | null;
  source: string | null;
  stage: string | null;
}

/**
 * Stripe payments the identity join could not attach to a contact.
 * Renders nothing when the list is empty. A manual match persists and is
 * never overwritten by the sync.
 */
export const UnmatchedPayments: React.FC = () => {
  const [items, setItems] = useState<UnmatchedPayment[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/payments?unmatched=1');
    const data = await res.json();
    setItems(Array.isArray(data.payments) ? data.payments : []);
  }, []);

  useEffect(() => {
    fetch('/api/payments?unmatched=1')
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data.payments) ? data.payments : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) {
      timer.current = setTimeout(() => setCandidates([]), 0);
      return;
    }
    timer.current = setTimeout(() => {
      fetch(`/api/contacts/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json())
        .then((d) => setCandidates(Array.isArray(d.people) ? d.people.slice(0, 8) : []))
        .catch(() => setCandidates([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const match = async (paymentId: string, contactId: string | null, label: string) => {
    setBusy(paymentId);
    try {
      const res = await fetch('/api/payments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId, contactId }),
      });
      const data = await res.json();
      if (data.ok) {
        setToast({ message: contactId ? `Matched to ${label}` : 'Marked as no match', type: 'success' });
        setActive(null);
        setQuery('');
        await load();
      } else {
        setToast({ message: 'Could not save match', detail: data.error, type: 'error' });
      }
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} strokeWidth={2.3} style={{ color: 'var(--warning)' }} />
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Unmatched payments ({items.length})
        </span>
        <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
          No contact shares this email or phone. Pick one so revenue lands on the right cohort.
        </span>
      </div>

      <ul className="space-y-1.5">
        {items.map((p) => (
          <li
            key={p.id}
            className="px-3 py-2 rounded-[8px] text-[12.5px]"
            style={{ background: 'var(--warning-muted)', border: '1px solid var(--warning-border)' }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="tabular" style={{ color: 'var(--text-primary)' }}>
                {formatCents(p.amountCents)}
              </strong>
              <span style={{ color: 'var(--text-secondary)' }}>{p.customerName ?? p.email ?? p.stripeId}</span>
              {p.customerName && p.email && (
                <span style={{ color: 'var(--text-quaternary)' }}>{p.email}</span>
              )}
              <span className="text-[11px]" style={{ color: 'var(--text-quaternary)' }}>
                {p.on ? new Date(p.on).toLocaleDateString() : ''}
              </span>
              <div className="flex-1" />
              <Button
                variant={active === p.id ? 'primary' : 'ghost'}
                onClick={() => {
                  setActive(active === p.id ? null : p.id);
                  setQuery('');
                }}
              >
                Match to contact
              </Button>
              <Button variant="ghost" icon={UserX} loading={busy === p.id} onClick={() => match(p.id, null, '')}>
                No match
              </Button>
            </div>

            {active === p.id && (
              <div className="mt-2">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or email…"
                  className="w-full h-8 px-2.5 text-[13px] rounded-[7px]"
                />
                {candidates.length > 0 && (
                  <ul className="mt-1.5 rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface)' }}>
                    {candidates.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => match(p.id, c.id, c.name)}
                          className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--surface-hover)]"
                        >
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {c.name}
                          </span>
                          <span style={{ color: 'var(--text-quaternary)' }}>{c.email}</span>
                          <div className="flex-1" />
                          {c.stage && (
                            <Badge variant="neutral" size="xs">
                              {c.stage}
                            </Badge>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim().length >= 2 && candidates.length === 0 && (
                  <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-quaternary)' }}>
                    No contacts match &ldquo;{query}&rdquo;.
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </div>
  );
};
