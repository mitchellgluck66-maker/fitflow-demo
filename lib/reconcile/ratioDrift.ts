/**
 * The Meta-to-FitFlow ratio drift rule (plan item 3) — PURE, table-tested.
 *
 * Per campaign: `rolling7` = Σ Meta submits ÷ Σ FitFlow applications over the last 7 account days,
 * `baseline` = the same over the 28 days before them. The doc's finding is a near-constant ~2× (the
 * pixel fires about twice per application); a change in that ratio is the signal.
 *
 * States, in the order they are decided:
 *   incomplete     a day in either window was never fetched (meta null) — never summed as 0
 *   learning       fewer than 28 baseline days with Meta data, or Σ FitFlow(28) = 0
 *   broken_meta    Σ meta7 ≥ 10 and Σ fitflow7 = 0  — Meta reports applications FitFlow cannot see
 *   broken_fitflow Σ fitflow7 ≥ 5 and Σ meta7 = 0   — FitFlow counts applications Meta does not attribute
 *   insufficient   Σ meta7 < 10 or Σ fitflow7 < 5 — too small to judge
 *   drift_up       rolling7 > 1.6 × baseline for 2 consecutive days
 *   drift_down     rolling7 < 0.6 × baseline for 2 consecutive days
 *   stable
 * Hysteresis: an open drift resolves only once the ratio is back inside 1.3× / 0.77× of the baseline.
 */

export type RatioState = 'incomplete' | 'learning' | 'broken_meta' | 'broken_fitflow' | 'insufficient' | 'drift_up' | 'drift_down' | 'stable';

export interface RatioDay {
  date: string;
  /** null = not fetched. */
  meta: number | null;
  fitflow: number;
}

export interface RatioVerdict {
  state: RatioState;
  rolling7: number | null;
  baseline: number | null;
  meta7: number;
  fitflow7: number;
  meta28: number;
  fitflow28: number;
  /** Days that were never fetched (for `incomplete`). */
  missingDays: string[];
  /** One sentence for the card and the incident. */
  text: string;
}

export const DRIFT_UP = 1.6;
export const DRIFT_DOWN = 0.6;
export const RESOLVE_UP = 1.3;
export const RESOLVE_DOWN = 0.77;
export const MIN_META_7 = 10;
export const MIN_FITFLOW_7 = 5;
export const BASELINE_DAYS = 28;
export const ROLLING_DAYS = 7;

const sum = (days: RatioDay[], f: (d: RatioDay) => number) => days.reduce((a, d) => a + f(d), 0);
const x = (r: number | null) => (r === null ? '—' : `${r.toFixed(2)}×`);

/**
 * Judge the window ending at `asOf` (inclusive). `days` must be one row per account day, sorted or not;
 * missing days count as never fetched. `previouslyDrifting` applies the hysteresis.
 */
export function judgeRatio(days: RatioDay[], asOf: string, previouslyDrifting: 'drift_up' | 'drift_down' | null = null): RatioVerdict {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dayList = (n: number, endOffset: number): RatioDay[] => {
    const out: RatioDay[] = [];
    for (let i = endOffset + n - 1; i >= endOffset; i--) {
      const date = shift(asOf, -i);
      out.push(byDate.get(date) ?? { date, meta: null, fitflow: 0 });
    }
    return out;
  };
  const w7 = dayList(ROLLING_DAYS, 0);
  const w28 = dayList(BASELINE_DAYS, ROLLING_DAYS);
  const meta7 = sum(w7, (d) => d.meta ?? 0);
  const fitflow7 = sum(w7, (d) => d.fitflow);
  const meta28 = sum(w28, (d) => d.meta ?? 0);
  const fitflow28 = sum(w28, (d) => d.fitflow);
  const missing7 = w7.filter((d) => d.meta === null).map((d) => d.date);
  const missing28 = w28.filter((d) => d.meta === null).map((d) => d.date);
  const base = { meta7, fitflow7, meta28, fitflow28, missingDays: [...missing28, ...missing7] };

  if (missing7.length) return { ...base, state: 'incomplete', rolling7: null, baseline: null, text: `incomplete — Meta submits not fetched for ${missing7.length} of the last 7 days (${missing7.join(', ')})` };
  const rolling7 = fitflow7 > 0 ? meta7 / fitflow7 : null;
  if (missing28.length || fitflow28 === 0) {
    const baselineText = missing28.length ? `${BASELINE_DAYS - missing28.length} of ${BASELINE_DAYS} baseline days fetched` : 'no FitFlow applications in the 28 baseline days';
    if (meta7 >= MIN_META_7 && fitflow7 === 0) return { ...base, state: 'broken_meta', rolling7, baseline: null, text: `Meta reports ${meta7} applications in 7 days that FitFlow cannot see (0 tracked to this campaign) — utm or form routing` };
    return { ...base, state: 'learning', rolling7, baseline: null, text: `learning — ${baselineText}; last 7 days Meta ${meta7} / FitFlow ${fitflow7}${rolling7 !== null ? ` (${x(rolling7)})` : ''}` };
  }
  const baseline = meta28 / fitflow28;
  if (meta7 >= MIN_META_7 && fitflow7 === 0) return { ...base, state: 'broken_meta', rolling7, baseline, text: `Meta reports ${meta7} applications in 7 days that FitFlow cannot see (0 tracked to this campaign) — utm or form routing` };
  if (fitflow7 >= MIN_FITFLOW_7 && meta7 === 0) return { ...base, state: 'broken_fitflow', rolling7, baseline, text: `FitFlow counts ${fitflow7} applications in 7 days that Meta does not attribute (0 submits) — the pixel or the campaign` };
  if (meta7 < MIN_META_7 || fitflow7 < MIN_FITFLOW_7) return { ...base, state: 'insufficient', rolling7, baseline, text: `too small to judge — last 7 days Meta ${meta7} / FitFlow ${fitflow7}${rolling7 !== null ? ` (${x(rolling7)})` : ''} vs baseline ${x(baseline)}` };
  const r = rolling7!;
  // Two consecutive days: the window ending yesterday must have drifted the same way (with a complete 7-day window).
  const yesterday = judgeOnce(days, shift(asOf, -1));
  const up = r > DRIFT_UP * baseline;
  const down = r < DRIFT_DOWN * baseline;
  const stillUp = previouslyDrifting === 'drift_up' && r > RESOLVE_UP * baseline;
  const stillDown = previouslyDrifting === 'drift_down' && r < RESOLVE_DOWN * baseline;
  if ((up && yesterday.up) || stillUp) return { ...base, state: 'drift_up', rolling7, baseline, text: `Meta-to-FitFlow ratio drifted UP to ${x(r)} (baseline ${x(baseline)}) — Meta ${meta7} / FitFlow ${fitflow7} in 7 days` };
  if ((down && yesterday.down) || stillDown) return { ...base, state: 'drift_down', rolling7, baseline, text: `Meta-to-FitFlow ratio drifted DOWN to ${x(r)} (baseline ${x(baseline)}) — Meta ${meta7} / FitFlow ${fitflow7} in 7 days` };
  return { ...base, state: 'stable', rolling7, baseline, text: `Meta counts ${x(r)} FitFlow's applications over 7 days (baseline ${x(baseline)}) — stable` };
}

/** The raw up/down test for one window end (no hysteresis, no two-day rule). */
function judgeOnce(days: RatioDay[], asOf: string): { up: boolean; down: boolean } {
  const byDate = new Map(days.map((d) => [d.date, d]));
  let meta7 = 0;
  let fitflow7 = 0;
  let meta28 = 0;
  let fitflow28 = 0;
  let missing = false;
  for (let i = 0; i < ROLLING_DAYS + BASELINE_DAYS; i++) {
    const d = byDate.get(shift(asOf, -i));
    if (!d || d.meta === null) {
      missing = true;
      break;
    }
    if (i < ROLLING_DAYS) {
      meta7 += d.meta;
      fitflow7 += d.fitflow;
    } else {
      meta28 += d.meta;
      fitflow28 += d.fitflow;
    }
  }
  if (missing || fitflow28 === 0 || fitflow7 < MIN_FITFLOW_7 || meta7 < MIN_META_7) return { up: false, down: false };
  const r = meta7 / fitflow7;
  const b = meta28 / fitflow28;
  return { up: r > DRIFT_UP * b, down: r < DRIFT_DOWN * b };
}

export function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
