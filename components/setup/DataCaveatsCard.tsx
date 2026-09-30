'use client';

import { useBusinessTimezone } from '../BusinessTimezone';
import React, { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { AccordionCard, Badge, Button, Input, Toast } from '@/components';
import { MATURITY_DEFAULTS, computeMaturity, maturingCaveatText } from '@/lib/metrics/maturity';
import { todayInTimezone } from '@/lib/dates';
import { fetchJson } from '@/lib/clientFetch';
import { FetchError } from '@/components/FetchError';

/**
 * Setup → Data caveats: the two dates behind the self-expiring "maturing
 * data" badge. history_complete_since = first day with complete stage
 * history (live observation start); disclaimer_sunset = the day the notice
 * retires everywhere, no redeploy.
 */
export const DataCaveatsCard: React.FC = () => {
  // Business timezone from the layout (F8); the card's "today" and the sunset check use it. 'UTC' only when it is
  // missing — the layout's banner already names that error, and the card shows it too.
  const business = useBusinessTimezone();
  const timezone = business.timezone ?? 'UTC';
  const [since, setSince] = useState<string>(MATURITY_DEFAULTS.historyCompleteSince);
  const [sunset, setSunset] = useState<string>(MATURITY_DEFAULTS.disclaimerSunset);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    fetchJson<{ historyCompleteSince?: string; disclaimerSunset?: string }>('/api/settings')
      .then((d) => {
        setLoadError(null);
        if (d.historyCompleteSince) setSince(d.historyCompleteSince);
        if (d.disclaimerSunset) setSunset(d.disclaimerSunset);
        setLoaded(true);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [attempt]);
  const retry = () => {
    setLoadError(null);
    setAttempt((a) => a + 1);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ historyCompleteSince: since, disclaimerSunset: sunset }) });
      setToast({ message: r.ok ? 'Data caveat dates saved' : 'Could not save', type: r.ok ? 'success' : 'error' });
    } finally {
      setBusy(false);
    }
  };

  const today = todayInTimezone(timezone);
  const retired = today >= sunset;
  const preview = computeMaturity({ range: { start: '2026-06-01', end: today }, today, historyCompleteSince: since, sunset });

  return (
    <AccordionCard
      title="Data caveats"
      summary={!loaded ? (loadError ? 'Could not load' : 'Loading…') : retired ? 'Maturing-data notice retired' : `Notice active for ranges before ${since} · retires ${sunset}`}
      subtitle="Live stage history began on the first date; before it GoHighLevel kept only each person's latest stage. Affected numbers carry a small amber badge until the second date."
      icon={Hourglass}
      action={
        <Badge variant={retired ? 'neutral' : 'warning'} dot>
          {retired ? 'Retired' : 'Active'}
        </Badge>
      }
    >
      {loadError && !loaded && (
        <div className="mb-3">
          <FetchError compact title="Could not load the data caveat dates" error={loadError} onRetry={retry} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Stage history complete since" type="date" value={since} onChange={(e) => setSince(e.target.value)} hint="Ranges that start before this date get the badge on history-dependent numbers." />
        <Input label="Notice retires on" type="date" value={sunset} onChange={(e) => setSunset(e.target.value)} hint="From this day the badge and the AI caveat stop rendering everywhere — no redeploy." />
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <Button variant="primary" loading={busy} onClick={save} disabled={!since || !sunset}>
          Save
        </Button>
        <span className="text-[11.5px]" style={{ color: 'var(--text-quaternary)' }}>
          Badge wording today: “{maturingCaveatText(preview)}” · Affects consults booked, roadmaps booked, cost per lead / consult / roadmap and stage→stage conversions only.
        </span>
      </div>
      <Toast isVisible={toast !== null} message={toast?.message ?? ''} type={toast?.type ?? 'success'} onClose={() => setToast(null)} />
    </AccordionCard>
  );
};
