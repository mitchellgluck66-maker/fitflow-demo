/**
 * The ref index + text refs (2026-10-06, item 2): every tool result carries "label → {token}" lines built
 * from the same walk the ledger uses, so a copied token always resolves; names / reasons / the verdict are
 * text refs rendered verbatim; the index sits outside `data` and is never indexed itself; an unknown ref's
 * repair text points at the index.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { labelForPath, refIndex } from '@/lib/analyst/refIndex';
import { Ledger, ledgerEntries } from '@/lib/analyst/ledger';
import { renderText, NO_SOURCE } from '@/lib/analyst/render';
import { refTokens, suggest, verifyAnswer } from '@/lib/analyst/verify';
import { checkDirection } from '@/lib/analyst/direction';
import { calculateBatch, runAnalystTool, type Freshness, type ToolContext } from '@/lib/analyst/tools';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import type { Answer } from '@/lib/analyst/schema';

const DATA = {
  kpis: { paidCacCents: { current: 92_442, previous: 184_884, abs: -92_442, pct: -0.5 }, enrollments: { current: 8, previous: 4 } },
  marketing: { spendCents: 369_768, ltvCoverage: { used: 21, total: 24, note: 'Based on 21 of 24 new clients · 3 missing contract value', missing: ['Ravi Brown', 'Marcus Jackson'] } },
  verdict: { verdict: 'normal', reason: 'normal: 4 new paying clients vs 4.25/week over 8 weeks (0.94×)', clients: 4, unit: 'number' },
  campaigns: [{ campaign: 'Summer Shred — Broad', spendCents: 110_485, roas: 2.1 }, { campaign: 'Brand Search', spendCents: 50_000, roas: null }],
  baseline: { conversions: [{ from: 'applied', to: 'consult_booked', unit: 'pct', current: 0.55, baseline: 0.47 }] },
  sources: [{ source: 'Facebook', applied: 20 }],
  internal: { longText: 'x'.repeat(50), id: 'abc' },
};

describe('refIndex', () => {
  it('one line per citeable leaf, labelled; text refs marked; strings outside the text-ref keys are not indexed', () => {
    const idx = refIndex('r2', DATA);
    expect(idx).toContain('kpis · Paid CAC · current → {r2:data.kpis.paidCacCents.current}');
    expect(idx).toContain('kpis · Paid CAC · change % → {r2:data.kpis.paidCacCents.pct}');
    expect(idx).toContain('kpis · Enrollments · current → {r2:data.kpis.enrollments.current}');
    expect(idx).toContain('marketing · Spend → {r2:data.marketing.spendCents}');
    expect(idx).toContain('marketing · LTV:CAC coverage · records used → {r2:data.marketing.ltvCoverage.used}'.replace('LTV:CAC coverage', 'ltvCoverage'));
    expect(idx).toContain('marketing · ltvCoverage · note (text) → {r2:data.marketing.ltvCoverage.note}');
    expect(idx).toContain('verdict · verdict (text) → {r2:data.verdict.verdict}');
    expect(idx).toContain('verdict · reason (text) → {r2:data.verdict.reason}');
    expect(idx).toContain('campaigns · Summer Shred — Broad · Spend → {r2:data.campaigns[0].spendCents}');
    expect(idx).toContain('campaigns · Brand Search · ROAS → {r2:data.campaigns[1].roas}');
    expect(idx).toContain('baseline · conversions · applied→consult_booked · current → {r2:data.baseline.conversions[0].current}');
    expect(idx).toContain('sources · Facebook · Applied → {r2:data.sources[0].applied}');
    expect(idx.some((l) => l.includes('longText') || l.includes('internal · id'))).toBe(false); // not a text-ref key
    expect(labelForPath('data.kpis.paidCacCents.current', DATA)).toBe('kpis · Paid CAC · current');
    // The index is OUTSIDE data: a result's refs are never themselves refs.
    const ledger = new Ledger();
    ledger.add('r2', DATA, '2026-10-06T00:00:00.000Z', 'CAD');
    expect(ledger.refs().some((r) => r.includes('refs'))).toBe(false);
    // Every token in the index resolves in the ledger built from the same data.
    for (const line of idx) expect(ledger.get(refTokens(line)[0].ref), line).toBeDefined();
  });

  it('text refs render verbatim, verify like any ref, are ignored by the direction check and refused by calculate', () => {
    const ledger = new Ledger();
    ledger.add('r2', DATA, '2026-10-06T00:00:00.000Z', 'CAD');
    expect(ledger.get('r2:data.verdict.verdict')).toMatchObject({ unit: 'text', text: 'normal', value: null });
    expect(ledger.get('r2:data.marketing.ltvCoverage.missing[0]')).toBeUndefined(); // a bare string in an array has no key
    expect(renderText('A {r2:data.verdict.verdict} week — {r2:data.verdict.reason}. Best: {r2:data.campaigns[0].campaign}. {r2:data.nope}', ledger)).toBe(`A normal week — normal: 4 new paying clients vs 4.25/week over 8 weeks (0.94×). Best: Summer Shred — Broad. ${NO_SOURCE}`);
    const answer: Answer = { kind: 'answer', headline: { text: 'A {r2:data.verdict.verdict} week.' }, sections: [{ key: 'what_happened', body_md: 'Paid CAC fell {r2:data.kpis.paidCacCents.pct} ({r2:data.verdict.reason}).' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' };
    expect(verifyAnswer(answer, ledger)).toMatchObject({ ok: true, verified: 3 });
    expect(checkDirection('Enrollments rose {r2:data.verdict.verdict}.', ledger)).toEqual([]); // a text ref is never a delta
    const rows = calculateBatch([{ label: 'x', op: 'sum', a: { kind: 'ref', ref: 'r2:data.verdict.verdict', value: 0 }, b: { kind: 'value', ref: '', value: 1 } }], 'r7', (r) => ledger.resolve(r), (r) => ledger.info(r));
    expect(rows[0].error).toMatch(/unknown ref/);
  });

  it('an unknown ref is refused with the index\'s nearest tokens — the composed-path failure the Oct 4 run showed', () => {
    const ledger = new Ledger();
    ledger.add('r2', DATA, '2026-10-06T00:00:00.000Z', 'CAD');
    expect(suggest(ledger, 'r2:data.kpis.paidCac.current')).toBe(' — the index has {r2:data.kpis.paidCacCents.current}');
    expect(suggest(ledger, 'r2:data.marketing.paidCacCents')).toContain('{r2:data.kpis.paidCacCents.current}');
    expect(suggest(ledger, 'r9:data.anything')).toBe('');
    const v = verifyAnswer({ kind: 'answer', headline: { text: 'CAC {r2:data.kpis.paidCac.current}.' }, sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: '' }, ledger);
    expect(v.flagged[0].reason).toBe('no such ref "r2:data.kpis.paidCac.current" — copy a token from a tool result\'s refs index, never compose a path — the index has {r2:data.kpis.paidCacCents.current}');
  });
});

describe('every real tool result carries its index (demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  it('get_scorecard: the core KPIs, the verdict and the baselines are in the index, every line resolves, and the index is bounded', async () => {
    const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
    const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
    const r = await runAnalystTool('get_scorecard', { range: { preset: 'last_week', start: '', end: '' }, compare: 'previous_period' }, ctx('r2'));
    expect(r.error).toBeUndefined();
    const idx = r.refs!;
    for (const want of ['kpis · Paid CAC · current → {r2:data.kpis.paidCacCents.current}', 'kpis · Blended CAC · current → {r2:data.kpis.blendedCacCents.current}', 'kpis · Initial cash · current → {r2:data.kpis.initialCents.current}', 'kpis · ROAS · current → {r2:data.kpis.roas.current}', 'kpis · LTV:CAC · current → {r2:data.kpis.ltvToCac.current}', 'verdict · verdict (text) → {r2:data.verdict.verdict}', 'baseline · new paying clients/week → {r2:data.baseline.newPayingClientsPerWeek}', 'enrollmentReconciliation · text (text) → {r2:data.enrollmentReconciliation.text}']) expect(idx, want).toContain(want);
    const ledger = new Ledger();
    ledger.add('r2', r.data, '2026-10-06T00:00:00.000Z', r.currency);
    for (const line of idx) expect(ledger.get(refTokens(line)[0].ref), line).toBeDefined();
    expect(idx.length).toBeLessThan(400);
    expect(JSON.stringify(idx).length).toBeLessThan(30_000);
    expect(JSON.stringify(ledgerEntries('r2', r.data, '', '').filter((e) => e.unit === 'text').length)).not.toBe('0');
  });
});
