'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Settings2, RotateCcw } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { DISPLAY_METRICS, DEFAULT_DISPLAYED_METRICS, type MetricGroup } from '@/lib/metrics/display';

const GROUPS: Array<{ group: MetricGroup; title: string; hint: string }> = [
  { group: 'kpi', title: 'KPI tiles', hint: 'The row of tiles at the top of the Ads tab.' },
  { group: 'platform', title: 'Platform-reported columns', hint: 'What Meta / Google say about the campaign.' },
  { group: 'tracked', title: 'FitFlow-tracked columns', hint: 'What actually happened to the people those campaigns sent.' },
];

/**
 * Loads settings.displayed_metrics once and exposes the enabled set. Every
 * metric is still computed and stored; this only decides what renders.
 */
export function useDisplayedMetrics(): { enabled: Set<string>; loaded: boolean; save: (keys: string[]) => Promise<void>; reset: () => Promise<void> } {
  const [enabled, setEnabled] = useState<Set<string>>(new Set(DEFAULT_DISPLAYED_METRICS));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/display-metrics')
      .then((r) => r.json())
      .then((d: { enabled?: string[] }) => {
        if (!cancelled && Array.isArray(d.enabled)) setEnabled(new Set(d.enabled));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (keys: string[]) => {
    const r = await fetch('/api/display-metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: keys }) });
    const d = await r.json();
    if (Array.isArray(d.enabled)) setEnabled(new Set(d.enabled));
  }, []);

  const reset = useCallback(async () => {
    const r = await fetch('/api/display-metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });
    const d = await r.json();
    if (Array.isArray(d.enabled)) setEnabled(new Set(d.enabled));
  }, []);

  return { enabled, loaded, save, reset };
}

/** Gear button + modal of checkboxes, grouped. Saves on Apply. */
export const DisplayedMetricsPanel: React.FC<{
  enabled: Set<string>;
  onSave: (keys: string[]) => Promise<void>;
  onReset: () => Promise<void>;
}> = ({ enabled, onSave, onReset }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(enabled);
  const [busy, setBusy] = useState(false);

  const openPanel = () => {
    setDraft(new Set(enabled));
    setOpen(true);
  };
  const toggle = (key: string) =>
    setDraft((d) => {
      const n = new Set(d);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const apply = async () => {
    setBusy(true);
    try {
      await onSave(Array.from(draft));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      await onReset();
      setDraft(new Set(DEFAULT_DISPLAYED_METRICS));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="ghost" icon={Settings2} onClick={openPanel} title="Choose which metrics the Ads tab shows">
        Displayed metrics
      </Button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Displayed metrics"
        description="Everything is pulled and stored regardless. Tick what should render on the Ads tab; the choice is saved for everyone."
        size="xl"
        actions={
          <div className="flex items-center gap-2 w-full">
            <Button variant="ghost" icon={RotateCcw} onClick={reset} disabled={busy}>
              Restore defaults
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={apply} loading={busy}>
              Apply
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {GROUPS.map((g) => (
            <div key={g.group}>
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] mb-0.5" style={{ color: 'var(--text-quaternary)' }}>
                {g.title}
              </div>
              <p className="text-[11.5px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                {g.hint}
              </p>
              <ul className="space-y-1.5">
                {DISPLAY_METRICS.filter((m) => m.group === g.group).map((m) => (
                  <li key={m.key}>
                    <label className="flex items-start gap-2 cursor-pointer rounded-[6px] px-1.5 py-1 hover:bg-[var(--surface-hover)]">
                      <input type="checkbox" className="mt-[3px]" checked={draft.has(m.key)} onChange={() => toggle(m.key)} />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {m.label}
                          {m.defaultOn && (
                            <span className="ml-1.5 text-[10.5px] font-normal" style={{ color: 'var(--text-quaternary)' }}>
                              default
                            </span>
                          )}
                        </span>
                        <span className="block text-[11.5px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                          {m.description}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
};
