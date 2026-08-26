import { describe, it, expect } from 'vitest';
import { deriveTransition, outcomeFromGhlStatus, normalizeEmail, normalizePhone } from '@/lib/ghl/transitions';

const roleOf = (id: string | null) =>
  id === 's-applied' ? 'applied' : id === 's-consult' ? 'consult_booked' : id === 's-enrolled' ? 'enrolled' : null;

const now = new Date('2026-08-26T15:00:00Z');
const prev = new Date('2026-08-26T14:00:00Z');

describe('deriveTransition', () => {
  it('records an initial sighting anchored to GHL createdAt', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-applied', createdAt: '2026-08-20T10:00:00Z' },
      null,
      'c1',
      roleOf,
      now,
      prev,
    );
    expect(t).toMatchObject({ kind: 'initial', fromStageId: null, toStageId: 's-applied', toRole: 'applied' });
    expect(t!.observedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('returns null when the stage is unchanged', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-applied' },
      { contactId: 'c1', pipelineId: 'p', stageId: 's-applied' },
      'c1',
      roleOf,
      now,
      prev,
    );
    expect(t).toBeNull();
  });

  it('diffs a stage move and keeps both time bounds', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-consult' },
      { contactId: 'c1', pipelineId: 'p', stageId: 's-applied' },
      'c1',
      roleOf,
      now,
      prev,
    );
    expect(t).toMatchObject({
      kind: 'diff',
      fromStageId: 's-applied',
      toStageId: 's-consult',
      fromRole: 'applied',
      toRole: 'consult_booked',
    });
    expect(t!.observedAt).toEqual(now);
    expect(t!.previousObservedAt).toEqual(prev);
  });

  it('trusts lastStageChangeAt when it is after the previous sync', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-enrolled', lastStageChangeAt: '2026-08-26T14:30:00Z' },
      { contactId: 'c1', pipelineId: 'p', stageId: 's-consult' },
      'c1',
      roleOf,
      now,
      prev,
    );
    expect(t!.observedAt.toISOString()).toBe('2026-08-26T14:30:00.000Z');
  });

  it('ignores a stale lastStageChangeAt older than the previous sync', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-enrolled', lastStageChangeAt: '2026-08-01T00:00:00Z' },
      { contactId: 'c1', pipelineId: 'p', stageId: 's-consult' },
      'c1',
      roleOf,
      now,
      prev,
    );
    expect(t!.observedAt).toEqual(now);
  });

  it('flags backfill rows', () => {
    const t = deriveTransition(
      { ghlOpportunityId: 'o1', pipelineId: 'p', stageId: 's-applied' },
      null,
      'c1',
      roleOf,
      now,
      null,
      true,
    );
    expect(t!.kind).toBe('backfill');
  });
});

describe('helpers', () => {
  it('maps GHL appointment statuses (noshow one word, cancelled double-L)', () => {
    expect(outcomeFromGhlStatus('showed')).toBe('showed');
    expect(outcomeFromGhlStatus('noshow')).toBe('no_show');
    expect(outcomeFromGhlStatus('cancelled')).toBe('cancelled');
    expect(outcomeFromGhlStatus('confirmed')).toBeNull();
    expect(outcomeFromGhlStatus(undefined)).toBeNull();
  });

  it('normalises identity keys', () => {
    expect(normalizeEmail('  Jake@Example.com ')).toBe('jake@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizePhone('(555) 123-4567')).toBe('15551234567');
    expect(normalizePhone('+1 555 123 4567')).toBe('15551234567');
    expect(normalizePhone(null)).toBeNull();
  });
});
