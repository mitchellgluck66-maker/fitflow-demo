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
