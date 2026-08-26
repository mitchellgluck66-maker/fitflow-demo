'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { FlaskConical, ArrowRight } from 'lucide-react';

interface Provenance {
  demoLeads: number;
  ghlLeads: number;
  demoAppointments: number;
  ghlAppointments: number;
  hasDemoData: boolean;
  hasRealData: boolean;
}

/**
 * Warns that the numbers on screen are fabricated.
 *
 * This exists because a dashboard full of invented data is indistinguishable
 * from a dashboard full of real data, and someone will eventually screenshot a
 * chart and treat it as a finding. The banner sits above the content on every
 * analytical page until real data is imported.
 */
export const SampleDataBanner: React.FC<{ page?: string }> = ({ page }) => {
  const [prov, setProv] = useState<Provenance | null>(null);

  useEffect(() => {
    fetch('/api/ghl/import')
      .then((r) => r.json())
      .then(setProv)
      .catch(() => {});
  }, []);

  if (!prov?.hasDemoData) return null;

  const mixed = prov.hasRealData;

  return (
    <div
      className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
      style={{
        background: 'var(--warning-muted)',
        border: '1px solid var(--warning-border)',
      }}
    >
      <FlaskConical
        size={15}
        strokeWidth={2.3}
        className="shrink-0"
        style={{ color: 'var(--warning)' }}
      />

      <div className="flex-1 min-w-[260px]">
        <p
          className="text-[12.5px] font-semibold leading-snug"
          style={{ color: 'var(--warning)' }}
        >
          {mixed
            ? 'This view mixes real and sample data'
            : `Sample data — these ${page ?? 'numbers'} are not your business`}
        </p>
        <p
          className="text-[11.5px] mt-0.5 leading-relaxed"
          style={{ color: 'var(--warning)', opacity: 0.85 }}
        >
          {prov.demoLeads} generated leads and {prov.demoAppointments} generated
          appointments are in the database. Every rate and trend shown here is computed
          from invented records.
        </p>
      </div>

      <Link href="/setup" className="shrink-0">
        <span
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[6px] text-[12px] font-semibold transition-opacity hover:opacity-80"
          style={{
            background: 'var(--warning)',
            color: '#fff',
          }}
        >
          Import real data
          <ArrowRight size={12} strokeWidth={2.5} />
        </span>
      </Link>
    </div>
  );
};
