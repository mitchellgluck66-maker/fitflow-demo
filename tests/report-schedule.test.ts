/**
 * Report schedules (2026-10-21): every report sends on the first :37 run after
 * 00:00 business time and covers the period that just ended. Pure — no DB.
 *
 * Edmonton: MDT (UTC−6) until Sun Nov 1 2026 02:00, then MST (UTC−7); MDT again
 * from Sun Mar 14 2027 02:00. The :37 dispatch therefore lands at 00:37 local
 * from 06:37 UTC in summer and 07:37 UTC in winter.
 */
import { describe, it, expect } from 'vitest';
import { reportDecision, periodEndedBefore, scorecardPresetPeriod, metaSettling, scheduleText, SENDS_AT_TEXT, isWeekend } from '@/lib/email/schedule';

const TZ = 'America/Edmonton';
const at = (iso: string) => new Date(iso);
const off = { includeWeekends: false };
const on = { includeWeekends: true };

describe('the midnight boundary (23:59 vs 00:01 business time)', () => {
  it('23:59 on Tue Oct 20 is still Oct 20: the daily due is for Oct 19 (already sent that morning)', () => {
    const d = reportDecision('daily', at('2026-10-21T05:59:00Z'), TZ, off); // 23:59 MDT Oct 20
    expect(d.localDate).toBe('2026-10-20');
    expect(d.period).toEqual({ start: '2026-10-19', end: '2026-10-19' });
  });
  it('00:01 on Wed Oct 21 flips the period to Oct 20 — the report for the day that just ended', () => {
    const d = reportDecision('daily', at('2026-10-21T06:01:00Z'), TZ, off); // 00:01 MDT Oct 21
    expect(d.localDate).toBe('2026-10-21');
    expect(d.period).toEqual({ start: '2026-10-20', end: '2026-10-20' });
    expect(d.due).toBe(true);
    expect(d.reason).toBeNull();
  });
  it('the :37 run (00:37 local) is the first run after midnight and is due; the 06:37 UTC instant is 00:37 MDT', () => {
    const d = reportDecision('daily', at('2026-10-21T06:37:00Z'), TZ, off);
    expect(d.localDate).toBe('2026-10-21');
    expect(d.due).toBe(true);
  });
  it('Saturday 23:59 is not yet Sunday: the weekly is not due; Sunday 00:01 it is, for the week that just ended', () => {
    const sat = reportDecision('weekly', at('2026-10-25T05:59:00Z'), TZ, off); // Sat Oct 24 23:59 MDT
    expect(sat.localDate).toBe('2026-10-24');
    expect(sat.due).toBe(false);
    expect(sat.reason).toContain('not Sunday');
    expect(sat.reason).toContain('Sun, Oct 25, 2026');
    const sun = reportDecision('weekly', at('2026-10-25T06:01:00Z'), TZ, off); // Sun Oct 25 00:01 MDT
    expect(sun.due).toBe(true);
    expect(sun.period).toEqual({ start: '2026-10-18', end: '2026-10-24' });
  });
});

describe('the weekend skip', () => {
  it('the Sunday 00:37 run would report Saturday → skipped, naming the day and the setting', () => {
    const d = reportDecision('daily', at('2026-10-25T06:37:00Z'), TZ, off);
    expect(d.period.start).toBe('2026-10-24');
    expect(isWeekend(d.period.start)).toBe(true);
    expect(d.due).toBe(false);
    expect(d.reason).toBe('weekend — the report for Sat, Oct 24, 2026 is skipped (Include weekends is off)');
  });
  it('the Monday 00:37 run would report Sunday → skipped too', () => {
    const d = reportDecision('daily', at('2026-10-26T06:37:00Z'), TZ, off);
    expect(d.period.start).toBe('2026-10-25');
    expect(d.due).toBe(false);
  });
  it('Tuesday reports Monday → due', () => {
    const d = reportDecision('daily', at('2026-10-27T06:37:00Z'), TZ, off);
    expect(d.period).toEqual({ start: '2026-10-26', end: '2026-10-26' });
    expect(d.due).toBe(true);
  });
  it('"Include weekends" on → both weekend reports are due', () => {
    expect(reportDecision('daily', at('2026-10-25T06:37:00Z'), TZ, on).due).toBe(true);
    expect(reportDecision('daily', at('2026-10-26T06:37:00Z'), TZ, on).due).toBe(true);
  });
});

describe('Sunday weekly', () => {
  it('Sunday 00:37: due, covering the Sun–Sat week that ended Saturday — the same period the scorecard reads as last_week', () => {
    const d = reportDecision('weekly', at('2026-10-25T06:37:00Z'), TZ, off);
    expect(d.due).toBe(true);
    expect(d.period).toEqual({ start: '2026-10-18', end: '2026-10-24' });
    expect(scorecardPresetPeriod('weekly', d.localDate)).toEqual(d.period);
  });
  it('Monday through Saturday: not due, with the next send named', () => {
    for (const day of ['26', '27', '28', '29', '30', '31']) {
      const d = reportDecision('weekly', at(`2026-10-${day}T06:37:00Z`), TZ, off);
      expect(d.due).toBe(false);
      expect(d.reason).toBe('not Sunday — the week ending Sat, Oct 31, 2026 sends after midnight on Sun, Nov 1, 2026');
      // The period is still the most recently ended week, so a forced run reports the right thing.
      expect(d.period).toEqual({ start: '2026-10-18', end: '2026-10-24' });
    }
  });
  it('a later run the same Sunday resolves to the same period (idempotent per period)', () => {
    const a = reportDecision('weekly', at('2026-10-25T06:37:00Z'), TZ, off);
    const b = reportDecision('weekly', at('2026-10-25T23:37:00Z'), TZ, off);
    expect(b.period).toEqual(a.period);
    expect(b.due).toBe(true);
  });
});

describe('the 1st monthly', () => {
  it('Nov 1 00:37 (07:37 UTC, MST): due for October 1–31 — the scorecard\'s last_month', () => {
    const d = reportDecision('monthly', at('2026-11-01T07:37:00Z'), TZ, off);
    expect(d.localDate).toBe('2026-11-01');
    expect(d.due).toBe(true);
    expect(d.period).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(scorecardPresetPeriod('monthly', d.localDate)).toEqual(d.period);
  });
  it('Oct 31 23:59 is not the 1st; Nov 2 is not either', () => {
    const eve = reportDecision('monthly', at('2026-11-01T05:59:00Z'), TZ, off); // Sat Oct 31 23:59 MDT
    expect(eve.localDate).toBe('2026-10-31');
    expect(eve.due).toBe(false);
    expect(eve.reason).toBe('not the 1st — this month sends after midnight on Sun, Nov 1, 2026');
    expect(eve.period).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(reportDecision('monthly', at('2026-11-02T07:37:00Z'), TZ, off).due).toBe(false);
  });
  it('Feb → Mar and Dec → Jan boundaries', () => {
    expect(periodEndedBefore('monthly', '2027-03-01')).toEqual({ start: '2027-02-01', end: '2027-02-28' });
    expect(periodEndedBefore('monthly', '2027-01-01')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
});

describe('a DST change night', () => {
  it('fall back, Sun Nov 1 2026: the 00:37 MDT run (06:37 UTC) — weekly + monthly due, Saturday\'s daily skipped', () => {
    const now = at('2026-11-01T06:37:00Z'); // 00:37 MDT, 80 min before the clocks go back
    const daily = reportDecision('daily', now, TZ, off);
    expect(daily.localDate).toBe('2026-11-01');
    expect(daily.period.start).toBe('2026-10-31');
    expect(daily.due).toBe(false); // a Saturday
    const weekly = reportDecision('weekly', now, TZ, off);
    expect(weekly.due).toBe(true);
    expect(weekly.period).toEqual({ start: '2026-10-25', end: '2026-10-31' });
    const monthly = reportDecision('monthly', now, TZ, off);
    expect(monthly.due).toBe(true);
    expect(monthly.period).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });
  it('the repeated hour: 07:37 UTC (01:37 MDT) and 08:37 UTC (01:37 MST) are the same local date → the same period, so the second run is already_sent', () => {
    const a = reportDecision('weekly', at('2026-11-01T07:37:00Z'), TZ, off);
    const b = reportDecision('weekly', at('2026-11-01T08:37:00Z'), TZ, off);
    expect(a.localDate).toBe('2026-11-01');
    expect(b.localDate).toBe('2026-11-01');
    expect(b.period).toEqual(a.period);
  });
  it('the night before the change still ends at local midnight: 05:59 UTC is Oct 31 23:59, 06:01 UTC is Nov 1 00:01', () => {
    expect(reportDecision('daily', at('2026-11-01T05:59:00Z'), TZ, off).localDate).toBe('2026-10-31');
    expect(reportDecision('daily', at('2026-11-01T06:01:00Z'), TZ, off).localDate).toBe('2026-11-01');
  });
  it('spring forward, Sun Mar 14 2027: the 00:37 MST run (07:37 UTC) — the weekly covers Mar 7–13; 03:37 MDT (09:37 UTC) agrees', () => {
    const a = reportDecision('weekly', at('2027-03-14T07:37:00Z'), TZ, off);
    expect(a.localDate).toBe('2027-03-14');
    expect(a.due).toBe(true);
    expect(a.period).toEqual({ start: '2027-03-07', end: '2027-03-13' });
    const b = reportDecision('weekly', at('2027-03-14T09:37:00Z'), TZ, off);
    expect(b.period).toEqual(a.period);
    // The next night the clock is MDT: 06:37 UTC is 00:37 local again.
    const mon = reportDecision('daily', at('2027-03-15T06:37:00Z'), TZ, off);
    expect(mon.localDate).toBe('2027-03-15');
    expect(mon.period.start).toBe('2027-03-14'); // Sunday → skipped
    expect(mon.due).toBe(false);
  });
});

describe('Meta spend "still settling"', () => {
  it('a day closed 40 min before the send is still settling; 48 h after its close it is settled', () => {
    expect(metaSettling('2026-10-20', TZ, at('2026-10-21T06:40:00Z'))).toBe(true); // 00:40 MDT Oct 21
    expect(metaSettling('2026-10-20', TZ, at('2026-10-23T05:30:00Z'))).toBe(true); // Oct 22 23:30 — 47.5 h
    expect(metaSettling('2026-10-20', TZ, at('2026-10-23T06:40:00Z'))).toBe(false); // Oct 23 00:40 — 48 h 40 min
  });
  it('is DST-aware: Oct 31 (MDT) closes at 06:00 UTC, Nov 1 (MST) at 07:00 UTC — settled exactly 48 h after each', () => {
    expect(metaSettling('2026-10-31', TZ, at('2026-11-03T05:59:00Z'))).toBe(true);
    expect(metaSettling('2026-10-31', TZ, at('2026-11-03T06:01:00Z'))).toBe(false);
    expect(metaSettling('2026-11-01', TZ, at('2026-11-04T06:59:00Z'))).toBe(true);
    expect(metaSettling('2026-11-01', TZ, at('2026-11-04T07:01:00Z'))).toBe(false);
  });
});

describe('what the report cards say', () => {
  it('no send-time field: a fixed "Sends ~12:40 am"', () => {
    expect(SENDS_AT_TEXT).toBe('Sends ~12:40 am');
    expect(scheduleText('daily', off)).toBe('Sends ~12:40 am · covers yesterday · weekends off');
    expect(scheduleText('daily', on)).toBe('Sends ~12:40 am · covers yesterday · every day');
    expect(scheduleText('weekly', off)).toBe('Sundays · Sends ~12:40 am · the Sun–Sat week just ended');
    expect(scheduleText('monthly', off)).toBe('1st of the month · Sends ~12:40 am · the month just ended');
  });
});
