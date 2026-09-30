'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Sparkles, ArrowRight, RefreshCw } from 'lucide-react';
import { Card, CardHeader, Button } from '@/components';

interface Finding {
  title: string;
  detail: string;
  metric: string;
  direction: 'up' | 'down' | 'flat';
  severity: 'info' | 'warning' | 'good';
  link: string;
}

interface InsightsState {
  notConfigured: boolean;
  findings: Finding[];
  generatedAt: string | null;
  model: string | null;
  /** The open anthropic_error incident, if an AI call is failing. */
  lastError?: string | null;
}

const DOT: Record<Finding['severity'], string> = {
  good: 'var(--positive, var(--success))',
  warning: 'var(--negative, var(--danger))',
  info: 'var(--accent)',
};

/**
 * Command Center insight card. Reads the latest cached findings for the
 * page's date range. Renders nothing while loading and nothing when there is
 * nothing to say; a one-line "Connect Anthropic" state until a key exists.
 */
export const InsightsCard: React.FC<{ rangeKey?: string }> = ({ rangeKey }) => {
  const params = useSearchParams();
  const [state, setState] = useState<InsightsState | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback(() => {
    const q = new URLSearchParams();
    for (const k of ['range', 'start', 'end', 'compare']) {
      const v = params.get(k);
      if (v) q.set(k, v);
    }
    return q.toString();
  }, [params]);

  const load = useCallback(() => {
    return fetch(`/api/anthropic/insights?${query()}`)
      .then((r) => r.json())
      .then((d: InsightsState) => setState(d))
      .catch(() => setState(null));
  }, [query]);

  useEffect(() => {
    load();
    // rangeKey lets a parent force a reload when its data changes.
  }, [load, rangeKey]);

  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    try {
      const body: Record<string, string | boolean> = { force: true };
      for (const k of ['range', 'start', 'end', 'compare']) {
        const v = params.get(k);
        if (v) body[k] = v;
      }
      const res = await fetch('/api/anthropic/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      setRefreshError(res.ok && d.ok !== false ? null : (d.error ?? d.detail ?? `HTTP ${res.status}`));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  if (state.notConfigured) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
        style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
      >
        <Sparkles size={14} strokeWidth={2.2} style={{ color: 'var(--text-quaternary)' }} />
        <span className="text-[12.5px] flex-1 min-w-[200px]" style={{ color: 'var(--text-tertiary)' }}>
          Connect Anthropic to get up to three specific findings here each night.
        </span>
        <Link href="/setup">
          <Button variant="ghost" iconRight={ArrowRight}>
            Connect Anthropic
          </Button>
        </Link>
      </div>
    );
  }

  // Never an empty card (2026-09-30): a failing AI call is shown with its reason.
  const failure = refreshError ?? state.lastError ?? null;
  if (state.findings.length === 0) {
    if (!failure) return null; // nothing notable this period, and nothing is failing
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 rounded-[10px]" style={{ background: 'var(--negative-muted, var(--danger-muted))', border: '1px solid var(--negative-border, var(--border-subtle))' }}>
        <Sparkles size={14} strokeWidth={2.2} style={{ color: 'var(--negative-text, var(--danger))' }} />
        <span className="text-[12.5px] flex-1 min-w-[200px]" style={{ color: 'var(--negative-text, var(--danger))' }}>
          Insights could not be generated: {failure}
        </span>
        <Button variant="ghost" loading={busy} onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Card padding="lg">
      <CardHeader
        title="Insights"
        subtitle="Specific findings for this period — nothing generic"
        icon={Sparkles}
        action={
          <div className="flex items-center gap-2">
            {busy && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }} aria-live="polite">
                Refreshing…
              </span>
            )}
            <Button variant="ghost" icon={RefreshCw} loading={busy} onClick={refresh}>
              Refresh
            </Button>
          </div>
        }
      />
      <ul className="space-y-3">
        {state.findings.slice(0, 3).map((f, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-[6px] shrink-0 rounded-full" style={{ width: 8, height: 8, background: DOT[f.severity] }} />
            <div className="flex-1 min-w-0">
              <p className="text-[13.5px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                {f.title}
              </p>
              <p className="text-[12.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {f.detail}
              </p>
            </div>
            <Link
              href={f.link}
              className="shrink-0 text-[12px] font-medium inline-flex items-center gap-1 mt-0.5"
              style={{ color: 'var(--accent)' }}
            >
              view <ArrowRight size={12} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[11px] mt-3" style={{ color: 'var(--text-quaternary)' }}>
        Generated {state.generatedAt ? new Date(state.generatedAt).toLocaleString() : '—'}
        {state.model ? ` · ${state.model}` : ''}
      </p>
    </Card>
  );
};
