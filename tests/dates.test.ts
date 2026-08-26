import { describe, it, expect } from 'vitest';
import {
  resolvePreset,
  previousPeriod,
  samePeriodLastYear,
  resolveComparison,
  weekStart,
  weekEnd,
  weekBuckets,
  trailingWeeks,
  formatRangeLabel,
  rangeToInstants,
  localDate,
  daysBetween,
  addMonths,
  monthEnd,
  rangeFromParams,
} from '@/lib/dates';

// 2026-08-26 is a Wednesday.
const TODAY = '2026-08-26';

describe('Sun–Sat weeks', () => {
  it('finds the Sunday/Saturday for every weekday', () => {
    // Sun Aug 23 … Sat Aug 29, 2026
    for (const d of ['2026-08-23', '2026-08-24', '2026-08-26', '2026-08-29']) {
      expect(weekStart(d)).toBe('2026-08-23');
      expect(weekEnd(d)).toBe('2026-08-29');
    }
    expect(weekStart('2026-08-30')).toBe('2026-08-30'); // next Sunday starts a new week
    expect(weekStart('2026-08-22')).toBe('2026-08-16'); // Saturday belongs to the prior week
  });

  it('crosses month boundaries without splitting the week', () => {
    // Sun Aug 30 – Sat Sep 5, 2026
    expect(weekStart('2026-09-01')).toBe('2026-08-30');
    expect(weekEnd('2026-09-01')).toBe('2026-09-05');
    // Year boundary: Sun Dec 27, 2026 – Sat Jan 2, 2027
    expect(weekStart('2027-01-01')).toBe('2026-12-27');
    expect(weekEnd('2026-12-31')).toBe('2027-01-02');
  });

  it('buckets a range into whole Sun–Sat weeks (padding both ends)', () => {
    const weeks = weekBuckets('2026-08-01', '2026-08-31');
    expect(weeks[0]).toMatchObject({ start: '2026-07-26', end: '2026-08-01', label: 'Jul 26 – Aug 1' });
    expect(weeks[weeks.length - 1]).toMatchObject({ start: '2026-08-30', end: '2026-09-05' });
    expect(weeks).toHaveLength(6);
    for (const w of weeks) expect(daysBetween(w.start, w.end)).toBe(7);
  });

  it('trailing 8 weeks end the Saturday before the current week', () => {
    const t = trailingWeeks(TODAY, 8);
    expect(t.end).toBe('2026-08-22');
    expect(t.start).toBe('2026-06-28');
    expect(t.weeks).toHaveLength(8);
    expect(t.weeks[0].start).toBe('2026-06-28');
  });
});

describe('presets', () => {
  it('resolves every preset for a Wednesday', () => {
    expect(resolvePreset('today', TODAY)).toMatchObject({ start: TODAY, end: TODAY, resolvedLabel: 'Aug 26' });
    expect(resolvePreset('yesterday', TODAY)).toMatchObject({ start: '2026-08-25', end: '2026-08-25' });
    expect(resolvePreset('this_week', TODAY)).toMatchObject({ start: '2026-08-23', end: '2026-08-29', resolvedLabel: 'Aug 23–29' });
    expect(resolvePreset('last_week', TODAY)).toMatchObject({ start: '2026-08-16', end: '2026-08-22', resolvedLabel: 'Aug 16–22' });
    expect(resolvePreset('this_month', TODAY)).toMatchObject({ start: '2026-08-01', end: '2026-08-31', resolvedLabel: 'Aug 1–31' });
    expect(resolvePreset('last_month', TODAY)).toMatchObject({ start: '2026-07-01', end: '2026-07-31' });
    expect(resolvePreset('last_30_days', TODAY)).toMatchObject({ start: '2026-07-28', end: TODAY, resolvedLabel: 'Jul 28 – Aug 26' });
  });

  it('this week on a Sunday and on a Saturday', () => {
    expect(resolvePreset('this_week', '2026-08-23')).toMatchObject({ start: '2026-08-23', end: '2026-08-29' });
    expect(resolvePreset('this_week', '2026-08-29')).toMatchObject({ start: '2026-08-23', end: '2026-08-29' });
    expect(resolvePreset('last_week', '2026-08-23')).toMatchObject({ start: '2026-08-16', end: '2026-08-22' });
  });

  it('last month across a year boundary and Feb lengths', () => {
    expect(resolvePreset('last_month', '2027-01-15')).toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
    expect(resolvePreset('this_month', '2028-02-10')).toMatchObject({ end: '2028-02-29' }); // leap year
    expect(monthEnd('2026-02-05')).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('custom swaps reversed bounds and falls back when invalid', () => {
    expect(resolvePreset('custom', TODAY, { start: '2026-08-10', end: '2026-08-01' })).toMatchObject({ start: '2026-08-01', end: '2026-08-10' });
    expect(resolvePreset('custom', TODAY, { start: 'nope', end: '2026-08-01' }).preset).toBe('last_30_days');
    expect(rangeFromParams({ range: 'garbage' }, TODAY).preset).toBe('last_30_days');
    expect(rangeFromParams({ range: 'custom', start: '2026-06-16', end: '2026-06-30' }, TODAY)).toMatchObject({ start: '2026-06-16', end: '2026-06-30' });
  });

  it('shows the year in labels only when it differs from today', () => {
    expect(formatRangeLabel('2025-08-17', '2025-08-23', 2026)).toBe('Aug 17–23, 2025');
    expect(formatRangeLabel('2026-12-27', '2027-01-02', 2026)).toBe('Dec 27, 2026 – Jan 2, 2027');
  });
});

describe('comparison ranges', () => {
  it('previous period keeps week alignment for week presets', () => {
    const lastWeek = resolvePreset('last_week', TODAY);
    expect(previousPeriod(lastWeek, TODAY)).toMatchObject({ start: '2026-08-09', end: '2026-08-15', resolvedLabel: 'Aug 9–15' });
  });

  it('previous period is the prior calendar month for month presets', () => {
    const thisMonth = resolvePreset('this_month', '2026-03-10');
    expect(previousPeriod(thisMonth, '2026-03-10')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('previous period is the same length immediately before for day ranges', () => {
    const r = resolvePreset('last_30_days', TODAY);
    const p = previousPeriod(r, TODAY);
    expect(p).toMatchObject({ start: '2026-06-28', end: '2026-07-27' });
    expect(daysBetween(p.start, p.end)).toBe(30);
    expect(previousPeriod(resolvePreset('today', TODAY), TODAY)).toMatchObject({ start: '2026-08-25', end: '2026-08-25' });
  });

  it('last year keeps Sun–Sat weeks by shifting 364 days', () => {
    const lastWeek = resolvePreset('last_week', TODAY);
    const ly = samePeriodLastYear(lastWeek, TODAY);
    expect(ly).toMatchObject({ start: '2025-08-17', end: '2025-08-23' });
    expect(weekStart(ly.start)).toBe(ly.start);
    expect(ly.resolvedLabel).toBe('Aug 17–23, 2025');
  });

  it('last year uses the same calendar month / dates otherwise', () => {
    expect(samePeriodLastYear(resolvePreset('this_month', TODAY), TODAY)).toMatchObject({ start: '2025-08-01', end: '2025-08-31' });
    expect(samePeriodLastYear(resolvePreset('last_30_days', TODAY), TODAY)).toMatchObject({ start: '2025-07-28', end: '2025-08-26' });
  });

  it('off yields no range; labels name exact dates', () => {
    const r = resolvePreset('last_week', TODAY);
    expect(resolveComparison(r, 'off', TODAY)).toMatchObject({ range: null });
    expect(resolveComparison(r, 'previous_period', TODAY).label).toBe('vs previous period · Aug 9–15');
    expect(resolveComparison(r, 'last_year', TODAY).label).toBe('vs same period last year · Aug 17–23, 2025');
  });
});

describe('DST and instants (business timezone, never UTC)', () => {
  it('a Sun–Sat week spanning the fall-back has 169 hours', () => {
    // DST ends Sun Nov 1, 2026 in America/New_York.
    const week = { start: '2026-11-01', end: '2026-11-07' };
    const i = rangeToInstants(week, 'America/New_York');
    expect(i.start.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // EDT midnight
    expect(i.end.toISOString()).toBe('2026-11-08T04:59:59.999Z'); // EST end of Saturday
    expect(Math.round((i.endMs - i.startMs + 1) / 3_600_000)).toBe(169);
  });

  it('a week spanning spring-forward has 167 hours', () => {
    // DST starts Sun Mar 8, 2026.
    const i = rangeToInstants({ start: '2026-03-08', end: '2026-03-14' }, 'America/New_York');
    expect(Math.round((i.endMs - i.startMs + 1) / 3_600_000)).toBe(167);
  });

  it('assigns a late-evening ET instant to the right local day and week', () => {
    // 11:30pm Saturday Aug 22 ET = 03:30Z Sunday Aug 23.
    const instant = new Date('2026-08-23T03:30:00Z');
    expect(localDate(instant, 'America/New_York')).toBe('2026-08-22');
    expect(weekStart(localDate(instant, 'America/New_York'))).toBe('2026-08-16');
    expect(localDate(instant, 'UTC')).toBe('2026-08-23'); // what UTC bucketing would wrongly say
  });
});
