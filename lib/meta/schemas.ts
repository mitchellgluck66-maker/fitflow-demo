/**
 * Zod schemas for the Meta Marketing API responses we consume (rule 7).
 * Insights numbers arrive as STRINGS ("12.34"); we coerce at the boundary.
 */

import { z } from 'zod';

const numString = z.union([z.string(), z.number()]).transform((v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
});
const optionalString = z.string().nullish();

export const MetaActionSchema = z.object({ action_type: z.string(), value: numString });

export const MetaInsightRowSchema = z.object({
  date_start: z.string().min(1),
  date_stop: z.string().min(1),
  campaign_id: optionalString,
  campaign_name: optionalString,
  adset_id: optionalString,
  adset_name: optionalString,
  ad_id: z.string().min(1),
  ad_name: optionalString,
  spend: numString.default(0),
  impressions: numString.default(0),
  clicks: numString.default(0),
  reach: numString.nullish(),
  frequency: numString.nullish(),
  cpm: numString.nullish(),
  cpc: numString.nullish(),
  /** Clicks that left Meta (the "link clicks" the CEO means; `clicks` counts everything). */
  inline_link_clicks: numString.nullish(),
  actions: z.array(MetaActionSchema).nullish(),
  account_currency: optionalString,
});
export type MetaInsightRow = z.infer<typeof MetaInsightRowSchema>;

export const MetaPagedSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z.object({ before: optionalString, after: optionalString }).nullish(),
      next: optionalString,
    })
    .nullish(),
});

export const MetaAccountSchema = z.object({
  id: z.string().min(1),
  name: optionalString,
  currency: optionalString,
  account_status: z.number().nullish(),
});
export type MetaAccount = z.infer<typeof MetaAccountSchema>;

/**
 * Leads as Meta reports them. `lead` covers lead-form + website lead events;
 * `onsite_conversion.lead_grouped` is the de-duplicated on-Facebook lead
 * count. Both are summed — Meta only emits one or the other per ad type.
 */
export const LEAD_ACTION_TYPES = ['lead', 'onsite_conversion.lead_grouped'] as const;

export function leadsFromActions(actions: MetaInsightRow['actions']): number {
  if (!actions) return 0;
  return actions.filter((a) => (LEAD_ACTION_TYPES as readonly string[]).includes(a.action_type)).reduce((s, a) => s + a.value, 0);
}

export function parseMany<T>(schema: z.ZodType<T>, items: unknown[], label: string): { valid: T[]; rejected: number; warnings: string[] } {
  const valid: T[] = [];
  let rejected = 0;
  const warnings: string[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) valid.push(r.data);
    else {
      rejected += 1;
      if (warnings.length < 3) warnings.push(`${label} failed validation: ${r.error.issues[0]?.message}`);
    }
  }
  if (rejected > 3) warnings.push(`${label}: ${rejected} rows rejected in total`);
  return { valid, rejected, warnings };
}

/** Purchases as Meta reports them (pixel / on-site / omni). Summed like leads. */
export const PURCHASE_ACTION_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.purchase'] as const;
export const LANDING_PAGE_VIEW_ACTION_TYPES = ['landing_page_view', 'omni_landing_page_view'] as const;

function sumActions(actions: MetaInsightRow['actions'], types: readonly string[]): number {
  if (!actions) return 0;
  return actions.filter((a) => types.includes(a.action_type)).reduce((s, a) => s + a.value, 0);
}

export function purchasesFromActions(actions: MetaInsightRow['actions']): number {
  return sumActions(actions, PURCHASE_ACTION_TYPES);
}

export function landingPageViewsFromActions(actions: MetaInsightRow['actions']): number {
  return sumActions(actions, LANDING_PAGE_VIEW_ACTION_TYPES);
}

/** Every action keyed by type — stored verbatim so nothing Meta reports is lost. */
export function actionsByType(actions: MetaInsightRow['actions']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of actions ?? []) out[a.action_type] = (out[a.action_type] ?? 0) + a.value;
  return out;
}
