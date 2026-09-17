/** Phase G item 7 — displayed-metrics catalog (pure). */
import { describe, it, expect } from 'vitest';
import { DISPLAY_METRICS, DEFAULT_DISPLAYED_METRICS, parseDisplayedMetrics, serializeDisplayedMetrics } from '@/lib/metrics/display';

describe('displayed metrics', () => {
  it('defaults are exactly the Sept-1 list', () => {
    expect([...DEFAULT_DISPLAYED_METRICS].sort()).toEqual(
      ['spend', 'cpm', 'cpc', 'link_clicks', 'cpl', 'cost_consult', 'cost_roadmap', 'cost_client', 'roas', 'tracked_applied', 'tracked_consults', 'tracked_roadmaps', 'tracked_enrolled', 'tracked_roas'].sort(),
    );
    expect(new Set(DISPLAY_METRICS.map((m) => m.key)).size).toBe(DISPLAY_METRICS.length);
  });

  it('parses stored JSON, drops unknown keys, falls back to defaults on garbage', () => {
    expect(parseDisplayedMetrics(null)).toEqual([...DEFAULT_DISPLAYED_METRICS]);
    expect(parseDisplayedMetrics('not json')).toEqual([...DEFAULT_DISPLAYED_METRICS]);
    expect(parseDisplayedMetrics('{"a":1}')).toEqual([...DEFAULT_DISPLAYED_METRICS]);
    expect(parseDisplayedMetrics('["reach","bogus","reach","spend"]')).toEqual(['reach', 'spend']);
    expect(parseDisplayedMetrics('[]')).toEqual([]); // the CEO may hide everything
  });

  it('serialises in catalog order', () => {
    expect(serializeDisplayedMetrics(['roas', 'spend', 'nope'])).toBe('["spend","roas"]');
  });
});
