/**
 * Displayed-metrics catalog (Phase G item 7) — PURE.
 *
 * Everything Meta reports is pulled and stored regardless; this catalog says
 * which Ads-tab KPI tiles and campaign-table columns RENDER. The CEO's
 * choice persists in settings.displayed_metrics as a JSON array of keys.
 * Default-on (from the Sept 1 meeting): spend, CPM, CPC, link clicks, CPL,
 * cost/consult, cost/roadmap, cost/client, ROAS.
 */

export type MetricGroup = 'platform' | 'tracked' | 'kpi';

export interface DisplayMetric {
  key: string;
  label: string;
  /** Where it renders: platform-reported column, FitFlow-tracked column, or a KPI tile. */
  group: MetricGroup;
  description: string;
  defaultOn: boolean;
}

export const DISPLAY_METRICS: readonly DisplayMetric[] = [
  // ---- KPI tiles (Ads tab) ----
  { key: 'spend', label: 'Spend', group: 'kpi', description: 'Total ad spend in the period (API rows first, manual weekly fallback).', defaultOn: true },
  { key: 'cpl', label: 'Cost per lead (CPL)', group: 'kpi', description: 'Spend ÷ applied (FitFlow-tracked).', defaultOn: true },
  { key: 'cost_consult', label: 'Cost per consult', group: 'kpi', description: 'Spend ÷ consults booked.', defaultOn: true },
  { key: 'cost_roadmap', label: 'Cost per roadmap', group: 'kpi', description: 'Spend ÷ roadmaps booked.', defaultOn: true },
  { key: 'cost_client', label: 'Cost per client (Blended CAC)', group: 'kpi', description: 'Spend ÷ all enrollments.', defaultOn: true },
  { key: 'paid_cac', label: 'Paid CAC', group: 'kpi', description: 'Spend ÷ paid-attributed enrollments.', defaultOn: false },
  { key: 'roas', label: 'ROAS', group: 'kpi', description: 'Paid-attributed initial cash ÷ spend.', defaultOn: true },

  // ---- Platform-reported columns (campaign table) ----
  { key: 'impressions', label: 'Impressions', group: 'platform', description: 'Times an ad was shown.', defaultOn: false },
  { key: 'reach', label: 'Reach', group: 'platform', description: 'Distinct people who saw an ad (Meta).', defaultOn: false },
  { key: 'frequency', label: 'Frequency', group: 'platform', description: 'Impressions ÷ reach.', defaultOn: false },
  { key: 'cpm', label: 'CPM', group: 'platform', description: 'Spend per 1,000 impressions.', defaultOn: true },
  { key: 'link_clicks', label: 'Link clicks', group: 'platform', description: 'Clicks that left the platform (Meta inline link clicks).', defaultOn: true },
  { key: 'clicks', label: 'Clicks (all)', group: 'platform', description: 'Every click Meta counts, including reactions and expands.', defaultOn: false },
  { key: 'cpc', label: 'CPC', group: 'platform', description: 'Spend ÷ link clicks.', defaultOn: true },
  { key: 'landing_page_views', label: 'Landing page views', group: 'platform', description: 'Meta landing_page_view actions.', defaultOn: false },
  { key: 'platform_leads', label: 'Platform leads', group: 'platform', description: 'Leads as the platform reports them.', defaultOn: false },
  { key: 'purchases', label: 'Platform purchases', group: 'platform', description: 'Purchase actions the platform attributes to the campaign.', defaultOn: false },

  // ---- FitFlow-tracked columns (campaign table) ----
  { key: 'tracked_applied', label: 'Applied (tracked)', group: 'tracked', description: 'Contacts whose utm_campaign matches, with cost per lead.', defaultOn: true },
  { key: 'tracked_consults', label: 'Consults (tracked)', group: 'tracked', description: 'Consults booked, with cost per consult.', defaultOn: true },
  { key: 'tracked_roadmaps', label: 'Roadmaps (tracked)', group: 'tracked', description: 'Roadmaps booked, with cost per roadmap.', defaultOn: true },
  { key: 'tracked_enrolled', label: 'Enrolled (tracked)', group: 'tracked', description: 'Enrollments, with cost per client.', defaultOn: true },
  { key: 'tracked_roas', label: 'ROAS (tracked)', group: 'tracked', description: 'Initial cash from matched contacts ÷ campaign spend.', defaultOn: true },
];

export const DISPLAY_METRIC_KEYS: readonly string[] = DISPLAY_METRICS.map((m) => m.key);

export const DEFAULT_DISPLAYED_METRICS: readonly string[] = DISPLAY_METRICS.filter((m) => m.defaultOn).map((m) => m.key);

export const DISPLAYED_METRICS_SETTING = 'displayed_metrics';

/** Parse the stored JSON; unknown keys are dropped, a broken/empty value means the defaults. */
export function parseDisplayedMetrics(raw: string | null | undefined): string[] {
  if (!raw) return [...DEFAULT_DISPLAYED_METRICS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_DISPLAYED_METRICS];
    const known = parsed.filter((k): k is string => typeof k === 'string' && DISPLAY_METRIC_KEYS.includes(k));
    return Array.from(new Set(known));
  } catch {
    return [...DEFAULT_DISPLAYED_METRICS];
  }
}

export function serializeDisplayedMetrics(keys: readonly string[]): string {
  return JSON.stringify(DISPLAY_METRIC_KEYS.filter((k) => keys.includes(k)));
}
