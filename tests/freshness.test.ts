/**
 * Family-level staleness (2026-09-29 production audit): the banner and
 * sync-health key off "when did the TRACKED phases last complete" per data
 * family — never off run activity. Nineteen partial runs with a Sep-18 last
 * completed cycle left appointments 11 days stale and every run row "partial".
 */
import { describe, it, expect } from 'vitest';
import { familyFreshness, GHL_FAMILIES, STALE_AFTER_HOURS, PARTIAL_ONLY_AFTER_HOURS } from '@/lib/sync/freshness';

const H = 3_600_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('familyFreshness', () => {
  it('a family completed 2 h ago is fresh; 30 h ago is stale (26 h threshold); never is stale', () => {
    expect(familyFreshness({ key: 'appointments', completedAt: new Date(NOW - 2 * H), lastRunAt: new Date(NOW - H), now: NOW })).toMatchObject({ stale: false, partialOnly: false, ageHours: 2 });
    expect(familyFreshness({ key: 'appointments', completedAt: new Date(NOW - 30 * H), lastRunAt: new Date(NOW - H), now: NOW })).toMatchObject({ stale: true, partialOnly: false });
    expect(familyFreshness({ key: 'appointments', completedAt: null, lastRunAt: null, now: NOW })).toMatchObject({ stale: true, partialOnly: false, ageHours: null, completedAt: null });
    expect(STALE_AFTER_HOURS).toBe(26);
  });

  it('THE AUDIT: runs every day for 11 days, appointments last completed 11 days ago → stale AND partial-only, and the detail names the family', () => {
    const f = familyFreshness({ key: 'appointments', completedAt: new Date(NOW - 11 * 24 * H), lastRunAt: new Date(NOW - H), now: NOW });
    expect(f.stale).toBe(true);
    expect(f.partialOnly).toBe(true);
    expect(f.detail).toBe('appointments: last completed 11 days ago — every run since has been partial');
    expect(PARTIAL_ONLY_AFTER_HOURS).toBe(48);
  });

  it('partial-only needs BOTH a run after the completion AND more than 48 h since it; a 30 h gap with no run since is stale but not partial-only', () => {
    expect(familyFreshness({ key: 'stages_opportunities', completedAt: new Date(NOW - 60 * H), lastRunAt: new Date(NOW - 70 * H), now: NOW })).toMatchObject({ stale: true, partialOnly: false });
    expect(familyFreshness({ key: 'stages_opportunities', completedAt: new Date(NOW - 30 * H), lastRunAt: new Date(NOW - H), now: NOW })).toMatchObject({ stale: true, partialOnly: false });
    expect(familyFreshness({ key: 'stages_opportunities', completedAt: new Date(NOW - 50 * H), lastRunAt: new Date(NOW - H), now: NOW })).toMatchObject({ stale: true, partialOnly: true });
    // never completed, but runs have been happening for three days
    expect(familyFreshness({ key: 'stages_opportunities', completedAt: null, lastRunAt: new Date(NOW - 72 * H), now: NOW }).detail).toBe('pipeline stages & opportunities: never completed — runs since have all been partial');
  });

  it('the two families the dashboard displays, in order', () => {
    expect(GHL_FAMILIES.map((f) => f.key)).toEqual(['stages_opportunities', 'appointments']);
  });
});
