/**
 * The ref index + text refs (2026-10-06, item 2): every tool result carries "label → {token}" lines built
 * from the same walk the ledger uses, so a copied token always resolves; names / reasons / the verdict are
 * text refs rendered verbatim; the index sits outside `data` and is never indexed itself; an unknown ref's
 * repair text points at the index.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { indexRule, indexTokens, labelForPath, refIndex } from '@/lib/analyst/refIndex';
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
  it('compact (Oct 7 item 5): the rule, then one line per parent with its exact keys; text refs marked; strings outside the text-ref keys absent; every listed key composes to a resolving token', () => {
    const idx = refIndex('r2', DATA);
    expect(idx[0]).toBe(indexRule('r2'));
    expect(idx[0]).toBe('token = {r2:data.<parent>.<key>} — paths and keys exactly as listed; (text) marks a text ref');
    expect(idx).toContain('data.kpis.paidCacCents (Paid CAC) → current · previous · abs · pct');
    expect(idx).toContain('data.kpis.enrollments (Enrollments) → current · previous');
    expect(idx).toContain('data.marketing → spendCents');
    expect(idx).toContain('data.marketing.ltvCoverage (LTV:CAC coverage) → used · total'); // `note` is an explanation, not a ref (Oct 7 item 4)
    expect(idx).toContain('data.verdict → verdict(text) · clients');
    expect(idx).toContain('data.campaigns[0] "Summer Shred — Broad" → campaign(text) · spendCents · roas');
    expect(idx).toContain('data.campaigns[1] "Brand Search" → campaign(text) · spendCents · roas'); // roas null is listed: a withheld ref the verifier names as withheld
    expect(idx).toContain('data.baseline.conversions[0] "applied→consult_booked" → from(text) · to(text) · current · baseline');
    expect(idx).toContain('data.sources[0] "Facebook" → source(text) · applied');
    expect(idx.some((l) => l.includes('longText') || l.includes('internal'))).toBe(false); // not a text-ref key
    expect(labelForPath('data.kpis.paidCacCents.current', DATA)).toBe('kpis · Paid CAC · current');
    const ledger = new Ledger();
    ledger.add('r2', DATA, '2026-10-06T00:00:00.000Z', 'CAD');
    expect(ledger.refs().some((r) => r.includes('refs'))).toBe(false); // the index is outside data
    const composed = indexTokens('r2', idx);
    expect(composed).toContain('{r2:data.kpis.paidCacCents.current}');
    expect(composed).toContain('{r2:data.campaigns[0].campaign}');
    for (const t of composed) expect(ledger.get(refTokens(t)[0].ref), t).toBeDefined();
    expect(composed.length).toBe(ledger.refs().length); // the index licenses exactly the ledger's refs
    // The index is a fraction of the data it indexes, not a multiple of it.
    expect(JSON.stringify(idx).length).toBeLessThan(JSON.stringify(DATA).length);
  });

  it('text refs render verbatim, verify like any ref, are ignored by the direction check and refused by calculate', () => {
    const ledger = new Ledger();
    ledger.add('r2', DATA, '2026-10-06T00:00:00.000Z', 'CAD');
    expect(ledger.get('r2:data.verdict.verdict')).toMatchObject({ unit: 'text', text: 'normal', value: null });
    expect(ledger.get('r2:data.marketing.ltvCoverage.missing[0]')).toBeUndefined(); // a bare string in an array has no key
    expect(renderText('A {r2:data.verdict.verdict} week — {r2:data.verdict.reason}. Best: {r2:data.campaigns[0].campaign}. {r2:data.nope}', ledger)).toBe(`A normal week — ${NO_SOURCE}. Best: Summer Shred — Broad. ${NO_SOURCE}`); // a reason is a note: not citeable (Oct 7 item 4)
    const answer: Answer = { kind: 'answer', headline: { text: 'A {r2:data.verdict.verdict} week.' }, sections: [{ key: 'what_happened', body_md: 'Paid CAC fell {r2:data.kpis.paidCacCents.pct} ({r2:data.campaigns[0].campaign}).' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' };
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
    const freshness: Freshness = { stale: false, line: 'data fresh — test', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] };
    const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
    const r = await runAnalystTool('get_scorecard', { range: { preset: 'last_week', start: '', end: '' }, compare: 'previous_period' }, ctx('r2'));
    expect(r.error).toBeUndefined();
    const idx = r.refs!;
    const composed = indexTokens('r2', idx);
    for (const want of ['{r2:data.kpis.paidCacCents.current}', '{r2:data.kpis.blendedCacCents.current}', '{r2:data.kpis.initialCents.current}', '{r2:data.kpis.roas.current}', '{r2:data.kpis.ltvToCac.current}', '{r2:data.verdict.verdict}', '{r2:data.verdict.basisClients}', '{r2:data.baseline.newPayingClientsPerWeek}', '{r2:data.enrollmentReconciliation.enrolledInGhl}']) expect(composed, want).toContain(want);
    expect(composed).not.toContain('{r2:data.enrollmentReconciliation.text}'); // a note: read, not cited
    expect(idx.find((l) => l.startsWith('data.kpis.paidCacCents'))).toContain('(Paid CAC) → current');
    expect(idx.some((l) => l.startsWith('data.verdict →') && l.includes('rule'))).toBe(false); // the rule lives in the glossary, not in the prefix
    const ledger = new Ledger();
    ledger.add('r2', r.data, '2026-10-06T00:00:00.000Z', r.currency);
    for (const t of composed) expect(ledger.get(refTokens(t)[0].ref), t).toBeDefined();
    expect(composed.length).toBe(ledger.refs().length);
    // Oct 7 item 5: the index is a fraction of the data (it was 3× before).
    expect(JSON.stringify(idx).length).toBeLessThan(JSON.stringify(r.data).length);
    expect(JSON.stringify(idx).length).toBeLessThan(8_000);
    expect(JSON.stringify(ledgerEntries('r2', r.data, '', '').filter((e) => e.unit === 'text').length)).not.toBe('0');
  });
});
