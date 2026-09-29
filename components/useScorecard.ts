'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ScorecardResult } from '@/lib/metrics/service';
import { CURRENCY_CHANGED_EVENT } from '@/lib/money';

/**
 * Loads /api/scorecard for the range/comparison currently in the URL.
 * One picker per page, one fetch per page — every number on the page comes
 * from the same response.
 */
export function useScorecard(): {
  data: ScorecardResult | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const params = useSearchParams();
  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of ['range', 'start', 'end', 'compare']) {
      const v = params.get(key);
      if (v) q.set(key, v);
    }
    return q.toString();
  }, [params]);

  const [data, setData] = useState<ScorecardResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scorecard?${query}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail ?? body.error ?? 'Request failed');
        return body as ScorecardResult;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // The reporting currency is business-wide: when it flips, re-fetch so every
  // figure is re-converted server-side from the stored originals.
  useEffect(() => {
    window.addEventListener(CURRENCY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CURRENCY_CHANGED_EVENT, reload);
  }, [reload]);

  return { data, loading, error, reload };
}
