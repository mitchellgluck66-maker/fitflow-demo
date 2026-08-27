import { z } from 'zod';

export const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

export const GoogleAdsRowSchema = z.object({
  segments: z.object({ date: z.string().min(1) }).optional(),
  campaign: z.object({ id: z.union([z.string(), z.number()]).optional(), name: z.string().optional(), resourceName: z.string().optional() }).optional(),
  customer: z.object({ id: z.union([z.string(), z.number()]).optional() }).optional(),
  metrics: z
    .object({
      costMicros: z.union([z.string(), z.number()]).optional(),
      impressions: z.union([z.string(), z.number()]).optional(),
      clicks: z.union([z.string(), z.number()]).optional(),
      conversions: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});
export type GoogleAdsRow = z.infer<typeof GoogleAdsRowSchema>;

/** searchStream returns an array of batches, each with `results`. */
export const GoogleAdsStreamSchema = z.array(
  z.object({
    results: z.array(z.unknown()).default([]),
    fieldMask: z.string().optional(),
    requestId: z.string().optional(),
  }),
);

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
