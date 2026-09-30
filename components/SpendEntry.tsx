'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button, Badge, Toast, Input, Select } from '@/components';
import { formatMoney, type Currency } from '@/lib/money';

interface SpendRow {
  platform: string;
  spendCents: number;
  currency: string;
  origin: string;
  externalId: string;
}
interface SpendWeek {
  start: string;
  end: string;
  label: string;
  rows: SpendRow[];
  /** Per currency — never summed across currencies. */
  totals: Record<string, number>;
}

const PLATFORMS = [
  { value: 'meta', label: 'Meta' },
  { value: 'google', label: 'Google' },
  { value: 'other', label: 'Other' },
];

/** Every amount is shown in the currency its row was stored in — Meta bills CAD, a manual entry is whatever was chosen (P1 #8). */
const money = (cents: number, currency: string) => formatMoney(Math.round(cents / 100) * 100, currency as Currency);

/** Manual weekly ad-spend entry: the fallback for weeks the ad platforms have not reported (API rows always win for their dates). */
export const SpendEntry: React.FC = () => {
  const [weeks, setWeeks] = useState<SpendWeek[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [weekOf, setWeekOf] = useState('');
  const [platform, setPlatform] = useState('meta');
  // The currency the amount is in — required, never assumed (2026-09-30). Preselected from the platform's account
  // currency when a sync has reported it.
  const [currency, setCurrency] = useState<'' | 'CAD' | 'USD'>('');
  const [accountCurrency, setAccountCurrency] = useState<Record<string, string | null>>({});
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<{ start: string; platform: string; value: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/spend?weeks=12');
      const data = await res.json();
      setWeeks(data.weeks ?? []);
      setAccountCurrency(data.accountCurrency ?? {});
      setWeekOf((w) => w || data.currentWeekStart || '');
    } catch {
      setToast({ message: 'Could not load spend', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body.
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  const save = async (wk: string, plat: string, amountDollars: number, note?: string) => {
    const cur = currency || accountCurrency[plat] || '';
    if (!cur) {
      setToast({ message: 'Choose the currency first', detail: 'The amount must say which currency it is in (CAD or USD) — it is never assumed.', type: 'error' });
      return false;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/spend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekOf: wk, platform: plat, amountDollars, currency: cur, notes: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: 'Could not save', detail: data.error, type: 'error' });
        return false;
      }
      setToast({ message: amountDollars === 0 ? 'Entry cleared' : `Saved ${money(amountDollars * 100, cur)} for ${data.week.label}`, type: 'success' });
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const n = Number(amount);
    if (!weekOf || Number.isNaN(n) || n < 0) {
      setToast({ message: 'Enter a week and a non-negative amount', type: 'error' });
      return;
    }
    if (await save(weekOf, platform, n, notes)) {
      setAmount('');
      setNotes('');
    }
  };

  const commitEdit = async () => {
    if (!editing) return;
    const n = Number(editing.value);
    const { start, platform: plat } = editing;
    setEditing(null);
    if (Number.isNaN(n) || n < 0) return;
    await save(start, plat, n);
  };

  const cell = (week: SpendWeek, plat: string) => {
    const rows = week.rows.filter((r) => r.platform === plat);
    const api = rows.find((r) => r.origin !== 'manual' && r.origin !== 'demo');
    const manual = rows.find((r) => r.origin === 'manual');
    const demo = rows.find((r) => r.origin === 'demo');
    const isEditing = editing?.start === week.start && editing.platform === plat;

    if (api) {
      return (
        <div className="flex items-center justify-end gap-1.5" title="Reported by the ad platform — manual entries for this week are ignored.">
          <span className="tabular">{money(api.spendCents, api.currency)}</span>
          <Badge variant="info" size="xs">from {api.origin === 'meta' ? 'Meta' : api.origin === 'google' ? 'Google' : api.origin}</Badge>
        </div>
      );
    }
    if (isEditing) {
      return (
        <input
          autoFocus
          type="number"
          min={0}
          step="0.01"
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(null);
          }}
          className="w-24 h-7 px-2 text-[12.5px] text-right rounded-[6px]"
          style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--accent)' }}
        />
      );
    }
    const shown = manual ?? demo;
    return (
      <button
        type="button"
        title="Click to edit"
        onClick={() => setEditing({ start: week.start, platform: plat, value: shown ? String(shown.spendCents / 100) : '' })}
        className="inline-flex items-center justify-end gap-1.5 h-7 px-2 rounded-[6px] tabular transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: shown ? 'var(--text-primary)' : 'var(--text-quaternary)' }}
      >
        {shown ? money(shown.spendCents, shown.currency) : '—'}
        {demo && !manual && <Badge variant="warning" size="xs">sample</Badge>}
      </button>
    );
  };

  return (
    <div>
      <p className="text-[12.5px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
        A fallback for weeks the ad platforms have not reported. Meta and Google API rows always take precedence for their dates; a manual week is spread over its 7 days and used only where no API row exists.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_0.8fr_1.4fr_auto] gap-2 items-end mb-4">
        <Input label="Week of" type="date" value={weekOf} onChange={(e) => setWeekOf(e.target.value)} hint="Any day — snaps to Sun–Sat" />
        <Select label="Source" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </Select>
        <Input label="Amount" type="number" min={0} step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Select
          label="Currency"
          value={currency || accountCurrency[platform] || ''}
          onChange={(e) => setCurrency(e.target.value as '' | 'CAD' | 'USD')}
          hint={!currency && accountCurrency[platform] ? `${platform === 'meta' ? 'Meta' : 'Google'} account currency` : 'Required'}
        >
          <option value="">Choose…</option>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
        </Select>
        <Input label="Notes" placeholder="optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="pb-[22px] sm:pb-0">
          <Button variant="primary" icon={Save} loading={busy} onClick={submit}>
            Save week
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                {['Week (Sun–Sat)', 'Meta', 'Google', 'Other', 'Total'].map((h, i) => (
                  <th
                    key={h}
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide ${i === 0 ? 'text-left' : 'text-right'}`}
                    style={{ color: 'var(--text-quaternary)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.start} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{w.label}</td>
                  {['meta', 'google', 'other'].map((p) => (
                    <td key={p} className="px-3 py-1.5 text-right">{cell(w, p)}</td>
                  ))}
                  <td className="px-3 py-1.5 text-right font-semibold tabular" style={{ color: 'var(--text-primary)' }}>
                    {Object.keys(w.totals).length ? Object.entries(w.totals).map(([ccy, cents]) => money(cents, ccy)).join(' · ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'success'} onClose={() => setToast(null)} />
    </div>
  );
};
