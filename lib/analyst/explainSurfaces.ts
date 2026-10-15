/**
 * Which glossary keys the UI wires to a "What does this mean?" button through DYNAMIC keys (Wave 2 item 6) — the
 * same constants the components iterate, so the coverage test (`tests/explain-coverage.test.ts`) can prove
 * GLOSSARY_KEYS ⊆ literals found in the source ∪ these. PURE, client-safe.
 *
 *   KpiDeltaTile   → every TREND_METRICS key (a tile's explain key defaults to its trendMetric)
 *   Funnel rows    → every funnel stage key; its conversion chips → conv_<from>_<to>; the dashed row → previous_leads
 *   Time in stage  → time_in_<role> for the stages that keep time
 *   CampaignTable  → the platform and tracked column keys, spend, tracked_roas
 */

import { FUNNEL_STAGES } from '../metrics';
import { TREND_METRICS } from '../metrics/trendMetrics';
import { GLOSSARY_KEYS } from '../metrics/glossary';

export const CAMPAIGN_COLUMN_KEYS = ['impressions', 'reach', 'frequency', 'cpm', 'link_clicks', 'clicks', 'cpc', 'landing_page_views', 'platform_leads', 'purchases', 'tracked_applied', 'tracked_consults', 'tracked_roadmaps', 'tracked_enrolled', 'spend', 'tracked_roas'] as const;

export const TIME_IN_STAGE_ROLES = ['applied', 'consult_booked', 'consult_showed', 'roadmap_booked', 'roadmap_showed'] as const;

const glossary = new Set<string>(GLOSSARY_KEYS);

/** A conversion chip's glossary key, or null when the glossary has no entry for that pair (a chip spanning a withheld stage). */
export function conversionKey(from: string, to: string): string | null {
  const k = `conv_${from}_${to}`;
  return glossary.has(k) ? k : null;
}

export function isGlossaryKey(key: string | null | undefined): key is string {
  return Boolean(key) && glossary.has(key as string);
}

/** Every key a dynamic surface can produce. */
export function dynamicExplainKeys(): string[] {
  const stages = FUNNEL_STAGES.map((s) => s.key as string);
  const convs: string[] = [];
  for (let i = 1; i < stages.length; i++) for (let j = 0; j < i; j++) {
    const k = conversionKey(stages[j], stages[i]);
    if (k) convs.push(k);
  }
  return [...new Set([...TREND_METRICS.map((m) => m.key), ...stages, ...convs, 'applied_to_enrolled', 'previous_leads', ...TIME_IN_STAGE_ROLES.map((r) => `time_in_${r}`), ...CAMPAIGN_COLUMN_KEYS])].filter((k) => glossary.has(k));
}
