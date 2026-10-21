/**
 * The partial-data rule (2026-09-30): a metric whose inputs are missing for SOME records is computed from the
 * records that have them (the rest out of both numerator and denominator) and shown with the coverage note;
 * 0 usable records → "not available: <reason>". The engine tests live next to each metric
 * (tests/marketing, scorecard, glossary, trend, analyst-tools); this file pins the SURFACES that must render
 * the note — there is no DOM harness in the repo, so it reads the sources (the screenshot is the live proof).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { coverageOf } from '@/lib/metrics';

const src = (p: string) => readFileSync(p, 'utf8');

describe('coverageOf', () => {
  it('is complete (no note) when every record has the input, partial with the one wording otherwise', () => {
    expect(coverageOf(24, 24, 'new clients', 'missing contract value')).toMatchObject({ partial: false, note: null, used: 24, total: 24, missing: [] });
    expect(coverageOf(21, 24, 'new clients', 'missing contract value', [{ contactId: 'x', name: 'X' }])).toMatchObject({ partial: true, note: 'Based on 21 of 24 new clients · 3 missing contract value', missing: [{ contactId: 'x', name: 'X' }] });
    expect(coverageOf(0, 0, 'new clients', 'missing contract value')).toMatchObject({ partial: false, note: null });
  });
});

describe('every surface renders the note', () => {
  it('KpiDeltaTile: the amber badge, the note and the names drawer', () => {
    const tile = src('components/KpiDeltaTile.tsx');
    expect(tile).toContain('data-testid="partial-badge"');
    expect(tile).toContain('data-testid="partial-note"');
    expect(tile).toContain('PeopleDrawer');
  });
  it('Command Center, Ads and Scorecard pass `partial` to the LTV:CAC / Paid CAC / ROAS tiles', () => {
    const home = src('app/page.tsx');
    expect(home).toContain('partial={marketing.ltvCoverage.partial');
    expect(home).toContain('ltvCoverage');
    expect(home).toContain('paidCacCoverage');
    expect(home).toContain('roasCoverage');
    const ads = src('app/ads/page.tsx');
    expect(ads).toContain('paidCacCoverage');
    expect(ads).toContain('roasCoverage');
    expect(src('app/scorecard/page.tsx')).toContain('partial={stat.partial ?? null}');
  });
  it('trend popover, digest, data-health notice, glossary, Analyst tools and contract carry it', () => {
    expect(src('components/KpiTrendPopover.tsx')).toContain('data-testid="trend-partial-note"');
    expect(src('lib/reports/weekly.ts')).toContain('partial.note'); // stage 3: the weekly / monthly reports render the assembled stats
    expect(src('lib/reports/monthly.ts')).toContain('partial.note');
    expect(src('components/DataHealth.tsx')).toContain('LTV:CAC is partial');
    expect(src('lib/metrics/glossary.ts')).toContain('coverage');
    expect(src('lib/analyst/tools.ts')).toContain('ltvCoverage: cov(');
    expect(src('lib/analyst/prompts.ts')).toContain('never present a partial figure as complete');
  });
});
