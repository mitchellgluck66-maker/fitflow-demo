import { describe, it, expect } from 'vitest';
import { getDayBounds, addDays } from '@/lib/day';

describe('business-day bounds (never UTC)', () => {
  it('computes New York day bounds across DST', () => {
    const summer = getDayBounds('2026-07-01', 'America/New_York');
    expect(summer.startIso).toBe('2026-07-01T04:00:00.000Z');
    expect(summer.endIso).toBe('2026-07-02T03:59:59.999Z');
    const winter = getDayBounds('2026-01-15', 'America/New_York');
    expect(winter.startIso).toBe('2026-01-15T05:00:00.000Z');
  });

  it('addDays stays calendar-correct across month ends', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
