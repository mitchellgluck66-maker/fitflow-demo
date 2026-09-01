/**
 * GHL boundary schemas: number fields must accept the string-encoded numbers
 * GHL actually sends (runtime evidence 2026-09-01: /opportunities/search
 * meta.nextPage arrived as "2" and the whole first real import parsed zero
 * opportunities). Docs say number; runtime evidence wins.
 */
import { describe, it, expect } from 'vitest';
import {
  GhlOpportunitySearchResponseSchema,
  GhlOpportunitySchema,
  GhlPipelineSchema,
} from '@/lib/ghl/schemas';

describe('GhlOpportunitySearchResponseSchema meta', () => {
  it('accepts pagination meta numbers sent as strings', () => {
    const parsed = GhlOpportunitySearchResponseSchema.parse({
      opportunities: [],
      meta: { total: '243', nextPage: '2', nextPageUrl: null, startAfterId: 'abc', startAfter: '1756700000000' },
    });
    expect(parsed.meta).toEqual({
      total: 243,
      nextPage: 2,
      nextPageUrl: null,
      startAfterId: 'abc',
      startAfter: 1756700000000,
    });
  });

  it('still accepts real numbers and null/absent meta fields', () => {
    expect(
      GhlOpportunitySearchResponseSchema.parse({ opportunities: [], meta: { total: 5, nextPage: null } }).meta,
    ).toMatchObject({ total: 5, nextPage: null });
    expect(GhlOpportunitySearchResponseSchema.parse({ opportunities: [] }).meta).toBeUndefined();
  });

  it('rejects non-numeric strings rather than importing garbage', () => {
    const res = GhlOpportunitySearchResponseSchema.safeParse({ opportunities: [], meta: { nextPage: 'two' } });
    expect(res.success).toBe(false);
  });
});

describe('other numeric GHL fields', () => {
  it('accepts monetaryValue as a string', () => {
    const opp = GhlOpportunitySchema.parse({
      id: 'opp-1',
      pipelineId: 'p-1',
      pipelineStageId: 's-1',
      contactId: 'ct-1',
      monetaryValue: '1500.50',
    });
    expect(opp.monetaryValue).toBe(1500.5);
  });

  it('accepts stage position as a string', () => {
    const pipe = GhlPipelineSchema.parse({
      id: 'p-1',
      name: 'Main',
      stages: [{ id: 's-1', name: 'Applied', position: '3' }],
    });
    expect(pipe.stages[0].position).toBe(3);
  });
});
