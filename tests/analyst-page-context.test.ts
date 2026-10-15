/**
 * Page context (Wave 2 item 5): the page key per route, the range through the same rangeFromParams the pages use
 * (anchored weeks, custom ranges, the per-page default), the comparison, the funnel mode (cohort unless ?mode=period),
 * the selected thing (metric / campaign / client / stage), an unknown route, and the context pill's text.
 */
import { describe, it, expect } from 'vitest';
import { contextPillText, pageContextFor, pageKeyFor } from '@/lib/analyst/pageContext';
import { rangeFromParams } from '@/lib/dates';

const TODAY = '2026-10-15'; // a Thursday
const params = (q: string) => new URLSearchParams(q);

describe('pageContextFor', () => {
  it('maps every route to its page key', () => {
    expect(pageKeyFor('/')).toEqual({ page: 'command_center', clientId: null });
    expect(pageKeyFor('/scorecard')).toEqual({ page: 'scorecard', clientId: null });
    expect(pageKeyFor('/funnel/')).toEqual({ page: 'funnel', clientId: null });
    expect(pageKeyFor('/clients')).toEqual({ page: 'clients', clientId: null });
    expect(pageKeyFor('/clients/abc-123')).toEqual({ page: 'client', clientId: 'abc-123' });
    expect(pageKeyFor('/setup')).toEqual({ page: 'setup', clientId: null });
    expect(pageKeyFor('/today')).toEqual({ page: 'unknown', clientId: null });
  });

  it('the context range equals the range the page requests for the same URL (the same rangeFromParams)', () => {
    for (const [path, q, preset] of [['/', '', 'last_30_days'], ['/scorecard', '', 'last_week'], ['/', 'range=last_week&compare=last_year', 'last_week'], ['/funnel', 'range=week&start=2026-10-07', 'week'], ['/ads', 'range=custom&start=2026-09-01&end=2026-09-30', 'custom'], ['/revenue', 'start=2026-09-01&end=2026-09-30', 'custom']] as const) {
      const ctx = pageContextFor(path, params(q), TODAY);
      const p = params(q);
      const expected = rangeFromParams({ range: p.get('range') ?? preset, start: p.get('start'), end: p.get('end') }, TODAY);
      expect(ctx.range, `${path}?${q}`).toEqual({ start: expected.start, end: expected.end, label: `${expected.presetLabel} · ${expected.resolvedLabel}` });
    }
    const week = pageContextFor('/funnel', params('range=week&start=2026-10-07'), TODAY);
    expect(week.range?.start).toBe('2026-10-04'); // the anchored Sun–Sat week around Oct 7
    expect(week.range?.end).toBe('2026-10-10');
    expect(pageContextFor('/', params('range=last_week&compare=last_year'), TODAY).compare).toBe('last_year');
    expect(pageContextFor('/', params('range=last_week&compare=off'), TODAY).compare).toBe('off');
    expect(pageContextFor('/', params(''), TODAY).compare).toBe('previous_period');
  });

  it('the funnel mode is cohort unless ?mode=period; other pages carry no mode; pages without a picker carry no range', () => {
    expect(pageContextFor('/funnel', params(''), TODAY).mode).toBe('cohort');
    expect(pageContextFor('/funnel', params('mode=period'), TODAY).mode).toBe('period');
    expect(pageContextFor('/', params(''), TODAY).mode).toBeNull();
    expect(pageContextFor('/clients', params(''), TODAY)).toMatchObject({ page: 'clients', range: null, compare: null, mode: null, selected: null });
    expect(pageContextFor('/setup', params(''), TODAY).range).toBeNull();
  });

  it('what was clicked rides along: a metric\'s explain button, a campaign row, the client page itself, a funnel stage; an unknown route is "unknown"', () => {
    const metric = pageContextFor('/', params(''), TODAY, { kind: 'metric', id: 'paid_cac', label: 'Paid CAC' });
    expect(metric.selected).toEqual({ kind: 'metric', id: 'paid_cac', label: 'Paid CAC' });
    expect(contextPillText(metric)).toBe('Viewing Paid CAC · Sep 16 – Oct 15');
    expect(pageContextFor('/ads', params(''), TODAY, { kind: 'campaign', id: 'meta:123', label: 'July 16 VSL' }).selected?.kind).toBe('campaign');
    expect(pageContextFor('/clients/abc', params(''), TODAY).selected).toEqual({ kind: 'client', id: 'abc' });
    expect(pageContextFor('/funnel', params(''), TODAY, { kind: 'stage', id: 'consult_booked', label: 'Consult booked' }).selected?.id).toBe('consult_booked');
    const unknown = pageContextFor('/today', params(''), TODAY);
    expect(unknown).toMatchObject({ page: 'unknown', range: null, selected: null });
    expect(contextPillText(unknown)).toBe('Viewing FitFlow');
    expect(contextPillText(pageContextFor('/', params('range=last_week'), TODAY))).toBe('Viewing Command Center · Oct 4–10');
    expect(contextPillText(pageContextFor('/clients', params(''), TODAY))).toBe('Viewing Clients');
  });
});
