/**
 * Maturing-data disclaimer — PURE, self-expiring.
 *
 * Live stage-history observation began 2026-09-01. Before that GoHighLevel
 * kept only each contact's LAST stage change, so every number that depends
 * on intermediate stage moves (consults booked, roadmaps booked, the costs
 * per lead / consult / roadmap, stage→stage conversion) runs low or high
 * for windows touching pre-Sept-1 dates. Enrollments, initial cash, Paid /
 * Blended CAC, ROAS, LTV:CAC and spend do not depend on that history and
 * never carry the caveat.
 *
 * The caveat is active only while BOTH hold: the selected range includes
 * days before `historyCompleteSince`, and today is before `sunset`. After
 * the sunset it never renders again — no redeploy. Both dates are settings
 * (Setup → Data caveats). The wording lives here once, for the badge, the
 * email and the AI context alike.
 */

import { formatRangeLabel } from '../dates';

export const MATURITY_SETTING_KEYS = {
  historyCompleteSince: 'history_complete_since',
  disclaimerSunset: 'disclaimer_sunset',
} as const;

export const MATURITY_DEFAULTS = {
  historyCompleteSince: '2026-09-01',
  disclaimerSunset: '2026-10-15',
} as const;

export interface DataMaturity {
  /** True when the caveat applies to the selected range today. */
  active: boolean;
  historyCompleteSince: string;
  sunset: string;
  /** The range that was evaluated. */
  range: { start: string; end: string };
  today: string;
  /** Why it is inactive, for the settings UI / tests. */
  reason: 'active' | 'range_after_history' | 'sunset_passed' | 'both';
}

/**
 * Metric keys (as used by tiles, the scorecard assembly and the trend
 * registry) whose value depends on intermediate stage history.
 */
export const HISTORY_DEPENDENT_METRICS: ReadonlySet<string> = new Set(['consults_booked', 'roadmaps_booked', 'cpl', 'cost_consult', 'cost_roadmap']);

/** Funnel stages whose count / chip depends on intermediate stage history. */
export const HISTORY_DEPENDENT_STAGES: ReadonlySet<string> = new Set(['consult_booked', 'roadmap_booked']);

export function computeMaturity(params: { range: { start: string; end: string }; today: string; historyCompleteSince?: string | null; sunset?: string | null }): DataMaturity {
  const historyCompleteSince = params.historyCompleteSince || MATURITY_DEFAULTS.historyCompleteSince;
  const sunset = params.sunset || MATURITY_DEFAULTS.disclaimerSunset;
  const rangeTouchesPartialHistory = params.range.start < historyCompleteSince;
  const beforeSunset = params.today < sunset;
  const active = rangeTouchesPartialHistory && beforeSunset;
  return {
    active,
    historyCompleteSince,
    sunset,
    range: { start: params.range.start, end: params.range.end },
    today: params.today,
    reason: active ? 'active' : !rangeTouchesPartialHistory && !beforeSunset ? 'both' : !rangeTouchesPartialHistory ? 'range_after_history' : 'sunset_passed',
  };
}

/** Does this metric carry the badge right now? Non-history metrics never do. */
export function isMaturingMetric(key: string, maturity: DataMaturity | null | undefined): boolean {
  return Boolean(maturity?.active) && HISTORY_DEPENDENT_METRICS.has(key);
}

/** Does this funnel stage's count/chip carry the badge right now? */
export function isMaturingStage(stageKey: string, maturity: DataMaturity | null | undefined): boolean {
  return Boolean(maturity?.active) && HISTORY_DEPENDENT_STAGES.has(stageKey);
}

export const MATURING_BADGE_LABEL = 'maturing data';

/** The one wording. Dates come from settings so the text stays true if they change. */
export function maturingCaveatText(m: Pick<DataMaturity, 'historyCompleteSince' | 'sunset'>): string {
  const since = formatRangeLabel(m.historyCompleteSince, m.historyCompleteSince);
  const until = formatRangeLabel(m.sunset, m.sunset);
  return `Stage history before ${since} is partial (GHL kept only each person's latest stage), so this number runs low/high. Accuracy improves daily; this notice retires ${until}.`;
}

/** What the AI context carries while the caveat is active (empty after sunset). */
export function dataCaveats(m: DataMaturity | null | undefined): string[] {
  if (!m?.active) return [];
  return [
    `${maturingCaveatText(m)} Affected in this snapshot: consults booked, roadmaps booked, cost per lead / consult / roadmap, and every stage→stage conversion. NOT affected: enrollments, initial cash, Paid CAC, Blended CAC, ROAS, LTV:CAC, spend. Mention the caveat whenever you cite an affected number.`,
  ];
}
