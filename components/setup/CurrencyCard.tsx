'use client';

import React, { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { AccordionCard, Badge, Button, Input, Select, Toast } from '@/components';
import { formatRate, type Currency, type FxRate } from '@/lib/money';

interface CurrencyState {
  today: string;
  reporting: Currency;
  contractCurrency: Currency;
  usdCad: number | null;
  note: string;
  rates: FxRate[];
}

/**
 * Setup → Currency (C1). Amounts keep the currency they were charged in; the
 * metrics engine converts to the reporting currency at read time, at each
 * transaction date's USD→CAD rate. This card maintains the current rate (a
 * manual row effective from today — past periods keep their own dates'
 * rates) and says which currency GHL contract values are entered in. There is
 * no external FX feed on purpose.
 */
export const CurrencyCard: React.FC = () => {
  const [state, setState] = useState<CurrencyState | null>(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const apply = (d: CurrencyState) => {
    setState(d);
    setRate(d.usdCad === null ? '' : formatRate(d.usdCad));
  };

  useEffect(() => {
    fetch('/api/currency')
      .then((r) => r.json())
      .then(apply)
      .catch(() => undefined);
  }, []);

  const post = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await fetch('/api/currency', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) apply(d);
      setToast({ message: r.ok ? ok : (d.error ?? 'Could not save'), type: r.ok ? 'success' : 'error' });
    } finally {
      setBusy(false);
    }
  };

  const seedOnly = state ? state.rates.length > 0 && state.rates.every((r) => r.source === 'seed') : false;
  const parsed = Number(rate);

  return (
    <AccordionCard
      title="Currency"
      summary={state ? state.note : 'Loading…'}
      subtitle="Payments arrive in CAD and USD; Meta bills in USD. Every amount is converted to the reporting currency when it is read, at its own date's rate — nothing stored is rewritten."
      icon={Coins}
      defaultOpen={seedOnly}
      action={
        state ? (
          <Badge variant={seedOnly ? 'warning' : 'neutral'} dot>
            {seedOnly ? 'Seed rates' : `Reporting in ${state.reporting}`}
          </Badge>
        ) : undefined
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={`Current USD → CAD rate (from ${state?.today ?? 'today'})`}
          type="number"
          step="0.0001"
          min={0.5}
          max={3}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          hint="1 USD = this many CAD. Applies from today until you change it; CAD → USD is the inverse."
        />
        <Select
          label="GoHighLevel contract values are in"
          value={state?.contractCurrency ?? 'CAD'}
          onChange={(e) => post({ contractCurrency: e.target.value }, 'Contract currency saved')}
          disabled={!state || busy}
        >
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <Button variant="primary" loading={busy} onClick={() => post({ usdCadRate: parsed }, 'Rate saved')} disabled={!(parsed > 0.5 && parsed < 3)}>
          Save rate
        </Button>
        {seedOnly && (
          <span className="text-[11.5px]" style={{ color: 'var(--warning)' }}>
            Only the seeded placeholder (flat 1.36 for 2026) is stored — enter the real rate, ideally the Bank of Canada monthly average.
          </span>
        )}
      </div>
      {state && state.rates.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)', color: 'var(--text-quaternary)' }}>
                <th className="text-left px-3 py-2 font-semibold">Effective from</th>
                <th className="text-right px-3 py-2 font-semibold">USD → CAD</th>
                <th className="text-right px-3 py-2 font-semibold">CAD → USD</th>
                <th className="text-left px-3 py-2 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody>
              {state.rates.map((r) => (
                <tr key={`${r.date}:${r.from}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-1.5 tabular" style={{ color: 'var(--text-secondary)' }}>{r.date}</td>
                  <td className="px-3 py-1.5 text-right tabular" style={{ color: 'var(--text-primary)' }}>{formatRate(r.rate)}</td>
                  <td className="px-3 py-1.5 text-right tabular" style={{ color: 'var(--text-tertiary)' }}>{formatRate(1 / r.rate)}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={r.source === 'seed' ? 'warning' : 'neutral'} size="xs">
                      {r.source === 'seed' ? 'seed (placeholder)' : 'manual'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Toast isVisible={toast !== null} message={toast?.message ?? ''} type={toast?.type ?? 'success'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
