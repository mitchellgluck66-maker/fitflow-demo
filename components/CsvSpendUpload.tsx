'use client';

import React, { useRef, useState } from 'react';
import { Upload, FileSpreadsheet } from 'lucide-react';
import { Card, CardHeader, Button, Toast, Select } from '@/components';

/**
 * Google Ads CSV fallback: until OAuth is granted, the UI export covers
 * Google spend. Imported rows are origin 'google_csv' and replace the manual
 * weekly fallback for the dates they cover (same precedence as API rows).
 */
export const CsvSpendUpload: React.FC<{ onImported?: () => void }> = ({ onImported }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // The account's currency — used only when the export has no "Currency code" column; never assumed (2026-09-30).
  const [currency, setCurrency] = useState<'' | 'CAD' | 'USD'>('');
  const [last, setLast] = useState<{ imported: number; dateRange: { start: string; end: string } | null; warnings: string[] } | null>(null);
  const [toast, setToast] = useState<{ message: string; detail?: string; type: 'success' | 'error' | 'info' } | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (currency) form.append('currency', currency);
      const res = await fetch('/api/googleads/csv', { method: 'POST', body: form });
      const data = await res.json();
      setLast(data.ok ? { imported: data.imported, dateRange: data.dateRange, warnings: data.warnings ?? [] } : null);
      setToast({
        message: data.ok ? `Imported ${data.imported} campaign-days` : 'Nothing imported',
        detail: data.message ?? data.error ?? (data.warnings ?? []).join(' '),
        type: data.ok ? 'success' : 'error',
      });
      if (data.ok) onImported?.();
    } catch (err) {
      setToast({ message: 'Upload failed', detail: String(err), type: 'error' });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Card padding="lg">
      <CardHeader
        title="Google Ads CSV"
        subtitle="Until Google grants API access: Campaigns → Download → CSV, with a Day segment"
        icon={FileSpreadsheet}
      />
      <p className="text-[12.5px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
        Rows are keyed by campaign + day, so re-uploading an overlapping export is safe. Imported days replace the manual weekly fallback for Google.
        The currency comes from the export&apos;s &ldquo;Currency code&rdquo; column; without one, choose the account currency — nothing is imported otherwise.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[140px]">
          <Select label="Account currency" value={currency} onChange={(e) => setCurrency(e.target.value as '' | 'CAD' | 'USD')}>
            <option value="">From the file</option>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </Select>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        <Button icon={Upload} loading={busy} onClick={() => inputRef.current?.click()}>
          Upload CSV
        </Button>
        {last && (
          <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Last import: {last.imported} rows
            {last.dateRange ? ` · ${last.dateRange.start} → ${last.dateRange.end}` : ''}
            {last.warnings.length ? ` · ${last.warnings.length} warning${last.warnings.length === 1 ? '' : 's'}` : ''}
          </span>
        )}
      </div>
      <Toast isVisible={toast !== null} message={toast?.message ?? ''} detail={toast?.detail} type={toast?.type ?? 'info'} onClose={() => setToast(null)} />
    </Card>
  );
};
