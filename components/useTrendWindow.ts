'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TREND_WINDOW, isTrendWindow, type TrendWindow } from '@/lib/metrics/trendMetrics';

const KEY = 'fitflow.trendWindow';

/**
 * The KPI trend drop-down's window (30d · 3m · 6m · 12m), remembered per
 * viewer in this browser — a convenience only: storage may be blocked, in
 * which case every popover opens on the 3-month default.
 */
export function useTrendWindow(): [TrendWindow, (w: TrendWindow) => void] {
  const [window, setWindow] = useState<TrendWindow>(DEFAULT_TREND_WINDOW);
  useEffect(() => {
    try {
      const stored = globalThis.localStorage?.getItem(KEY);
      if (isTrendWindow(stored)) setWindow(stored);
    } catch {
      /* storage blocked — keep the default */
    }
  }, []);
  const choose = useCallback((w: TrendWindow) => {
    setWindow(w);
    try {
      globalThis.localStorage?.setItem(KEY, w);
    } catch {
      /* storage blocked — the choice lasts for this view only */
    }
  }, []);
  return [window, choose];
}
