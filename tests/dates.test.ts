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
  stepPeriod,
  canStepForward,
  periodFamily,
  normalizePeriod,
  paramsForRange,
  periodTitle,
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

describe('period cycler (◀ ▶ one whole week / month)', () => {
  // 2026-09-17 is a Thursday: this week = Sun Sep 13 – Sat Sep 19.
  const NOW = '2026-09-17';

  it('classifies presets into a steppable family', () => {
    expect(periodFamily(resolvePreset('this_week', NOW))).toBe('week');
    expect(periodFamily(resolvePreset('last_month', NOW))).toBe('month');
    expect(periodFamily(resolvePreset('last_30_days', NOW))).toBeNull();
    expect(periodFamily(resolvePreset('today', NOW))).toBeNull();
  });

  it('steps weeks back Sun–Sat, naming last week and this week as it passes them', () => {
    const thisWeek = resolvePreset('this_week', NOW);
    const back1 = stepPeriod(thisWeek, -1, NOW);
    expect(back1).toMatchObject({ preset: 'last_week', start: '2026-09-06', end: '2026-09-12' });
    const back2 = stepPeriod(back1, -1, NOW);
    expect(back2).toMatchObject({ preset: 'week', start: '2026-08-30', end: '2026-09-05', resolvedLabel: 'Aug 30 – Sep 5' });
    expect(periodTitle(back2)).toBe('Week of Aug 30 – Sep 5');
    expect(periodTitle(back1)).toBe('Week of Sep 6–12');
    // Forward retraces exactly.
    expect(stepPeriod(back2, 1, NOW)).toEqual(back1);
    expect(stepPeriod(back1, 1, NOW)).toEqual(thisWeek);
  });

  it('▶ is disabled at the current week and month; stepping forward there is a no-op', () => {
    const thisWeek = resolvePreset('this_week', NOW);
    expect(canStepForward(thisWeek, NOW)).toBe(false);
    expect(stepPeriod(thisWeek, 1, NOW)).toBe(thisWeek);
    expect(canStepForward(resolvePreset('last_week', NOW), NOW)).toBe(true);
    const thisMonth = resolvePreset('this_month', NOW);
    expect(canStepForward(thisMonth, NOW)).toBe(false);
    expect(canStepForward(resolvePreset('last_month', NOW), NOW)).toBe(true);
    expect(canStepForward(resolvePreset('last_30_days', NOW), NOW)).toBe(false);
    expect(stepPeriod(resolvePreset('last_30_days', NOW), -1, NOW).preset).toBe('last_30_days');
  });

  it('weeks step across month and year boundaries without splitting', () => {
    // Anchored week Sun Dec 27, 2026 – Sat Jan 2, 2027 (year boundary inside the week)
    const w = rangeFromParams({ range: 'week', start: '2026-12-30' }, '2027-01-20');
    expect(w).toMatchObject({ preset: 'week', start: '2026-12-27', end: '2027-01-02' });
    expect(w.resolvedLabel).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(stepPeriod(w, -1, '2027-01-20')).toMatchObject({ start: '2026-12-20', end: '2026-12-26' });
    expect(stepPeriod(w, 1, '2027-01-20')).toMatchObject({ start: '2027-01-03', end: '2027-01-09' });
    // Month boundary: Aug 30 – Sep 5 → Sep 6–12
    expect(stepPeriod(rangeFromParams({ range: 'week', start: '2026-08-30' }, NOW), 1, NOW)).toMatchObject({ preset: 'last_week', start: '2026-09-06' });
  });

  it('months step as calendar months, including Jan ← Dec and short months', () => {
    const thisMonth = resolvePreset('this_month', NOW); // Sep 2026
    const aug = stepPeriod(thisMonth, -1, NOW);
    expect(aug).toMatchObject({ preset: 'last_month', start: '2026-08-01', end: '2026-08-31' });
    const jul = stepPeriod(aug, -1, NOW);
    expect(jul).toMatchObject({ preset: 'month', start: '2026-07-01', end: '2026-07-31' });
    expect(periodTitle(jul)).toBe('July 2026');
    expect(stepPeriod(jul, 1, NOW)).toEqual(aug);
    // Year boundary
    const jan = rangeFromParams({ range: 'month', start: '2027-01-15' }, '2027-03-10');
    expect(jan).toMatchObject({ start: '2027-01-01', end: '2027-01-31' });
    expect(stepPeriod(jan, -1, '2027-03-10')).toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
    expect(periodTitle(stepPeriod(jan, -1, '2027-03-10'))).toBe('December 2026');
    // Short months: Mar 31-anchored month → Feb (28 days) → back to Mar 31
    const mar = rangeFromParams({ range: 'month', start: '2026-03-31' }, NOW);
    const feb = stepPeriod(mar, -1, NOW);
    expect(feb).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
    expect(stepPeriod(feb, 1, NOW)).toMatchObject({ start: '2026-03-01', end: '2026-03-31' });
    // Leap February
    expect(stepPeriod(rangeFromParams({ range: 'month', start: '2028-03-01' }, '2028-06-01'), -1, '2028-06-01')).toMatchObject({ end: '2028-02-29' });
  });

  it('the comparison follows the stepped period, so chips are vs the period before the one shown', () => {
    const w = stepPeriod(stepPeriod(resolvePreset('this_week', NOW), -1, NOW), -1, NOW); // Aug 30 – Sep 5
    expect(previousPeriod(w, NOW)).toMatchObject({ start: '2026-08-23', end: '2026-08-29' });
    expect(samePeriodLastYear(w, NOW)).toMatchObject({ start: '2025-08-31', end: '2025-09-06' });
    const m = rangeFromParams({ range: 'month', start: '2026-06-01' }, NOW);
    expect(previousPeriod(m, NOW)).toMatchObject({ start: '2026-05-01', end: '2026-05-31' });
    expect(resolveComparison(m, 'last_year', NOW).range).toMatchObject({ start: '2025-06-01', end: '2025-06-30' });
  });

  it('URL round-trip: anchored params re-resolve to the same range and normalise to named presets', () => {
    const anchored = rangeFromParams({ range: 'week', start: '2026-08-05' }, NOW); // any day inside → its Sun–Sat week
    expect(anchored).toMatchObject({ preset: 'week', start: '2026-08-02', end: '2026-08-08' });
    expect(paramsForRange(anchored)).toEqual({ range: 'week', start: '2026-08-02', end: null });
    expect(rangeFromParams(paramsForRange(anchored), NOW)).toEqual(anchored);
    // Anchored at this week's Sunday → reads as "This week"
    expect(rangeFromParams({ range: 'week', start: '2026-09-13' }, NOW).preset).toBe('this_week');
    expect(rangeFromParams({ range: 'month', start: '2026-08-20' }, NOW).preset).toBe('last_month');
    expect(paramsForRange(resolvePreset('last_week', NOW))).toEqual({ range: 'last_week', start: null, end: null });
    expect(normalizePeriod(resolvePreset('last_30_days', NOW), NOW).preset).toBe('last_30_days');
    // Missing/invalid anchor falls back sanely.
    expect(rangeFromParams({ range: 'week', start: 'nope' }, NOW).preset).toBe('this_week');
    expect(rangeFromParams({ range: 'week' }, NOW).preset).toBe('last_30_days');
  });
});
