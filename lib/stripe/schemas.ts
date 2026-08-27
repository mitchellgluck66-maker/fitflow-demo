/**
 * Zod schemas for the Stripe objects we read (CLAUDE.md rule 7).
 * Permissive on optional fields; strict on the ids we key rows by.
 */

import { z } from 'zod';

const opt = z.string().nullish();

export const StripeCustomerSchema = z.object({
  id: z.string().min(1),
  email: opt,
  name: opt,
  phone: opt,
  deleted: z.boolean().nullish(),
});
export type StripeCustomer = z.infer<typeof StripeCustomerSchema>;

export const StripeChargeSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int(),
  amount_refunded: z.number().int().default(0),
  currency: z.string().default('usd'),
  status: z.enum(['succeeded', 'pending', 'failed']),
  created: z.number().int(),
  customer: z.union([z.string(), StripeCustomerSchema]).nullish(),
  billing_details: z
    .object({ email: opt, name: opt, phone: opt })
    .nullish(),
  description: opt,
  invoice: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  refunded: z.boolean().default(false),
  failure_message: opt,
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type StripeCharge = z.infer<typeof StripeChargeSchema>;

export const StripeSubscriptionSchema = z.object({
  id: z.string().min(1),
  customer: z.union([z.string(), StripeCustomerSchema]),
  status: z.string(),
  created: z.number().int(),
  current_period_start: z.number().int().nullish(),
  items: z.object({
    data: z
      .array(
        z.object({
          price: z
            .object({
              unit_amount: z.number().int().nullish(),
              recurring: z
                .object({ interval: z.enum(['day', 'week', 'month', 'year']), interval_count: z.number().int().default(1) })
                .nullish(),
            })
            .nullish(),
          quantity: z.number().int().nullish(),
        }),
      )
      .default([]),
  }),
});
export type StripeSubscription = z.infer<typeof StripeSubscriptionSchema>;

export const StripeRefundSchema = z.object({
  id: z.string().min(1),
  charge: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  amount: z.number().int(),
  created: z.number().int(),
  status: z.string().nullish(),
  reason: opt,
});
export type StripeRefund = z.infer<typeof StripeRefundSchema>;

export const StripeListSchema = z.object({
  data: z.array(z.unknown()).default([]),
  has_more: z.boolean().default(false),
});

export const StripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  created: z.number().int(),
  data: z.object({ object: z.unknown() }),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;

export const StripeBalanceSchema = z.object({ object: z.literal('balance').optional(), livemode: z.boolean().optional() });

export function parseMany<T>(schema: z.ZodType<T>, items: unknown[], label: string) {
  const valid: T[] = [];
  let rejected = 0;
  const warnings: string[] = [];
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) valid.push(r.data);
    else {
      rejected += 1;
      if (warnings.length < 3) {
        const id = item && typeof item === 'object' && 'id' in item ? String((item as { id: unknown }).id) : '?';
        warnings.push(`${label} ${id} failed validation: ${r.error.issues[0]?.message}`);
      }
    }
  }
  return { valid, rejected, warnings };
}
