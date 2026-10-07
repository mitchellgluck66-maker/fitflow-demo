/**
 * Text refs are phrases (Oct 7 item 4). A string under a PHRASE key is rendered verbatim inside the owner's
 * sentence, so every such value in every tool result must be embeddable: ≤ 12 words, no trailing period, no
 * " — " clause, never equal to or restating a sibling phrase ("Verdict: normal. normal: 4 new…" read twice).
 * Strings under NOTE keys (reason, note, text, line, …) are explanations: not in the ledger, refused with a
 * pointer when cited.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { Ledger, ledgerEntries, NOTE_KEYS, PHRASE_KEYS } from '@/lib/analyst/ledger';
import { runAnalystTool, type Freshness, type ToolContext } from '@/lib/analyst/tools';
import { verifyAnswer } from '@/lib/analyst/verify';
import { renderText, NO_SOURCE } from '@/lib/analyst/render';
import { freshnessSummary } from '@/lib/sync/sourceFreshness';
import type { Answer } from '@/lib/analyst/schema';

const T0 = '2026-10-07T00:00:00.000Z';
const words = (s: string) => s.trim().split(/\s+/).length;
const lastKey = (path: string) => (path.split(/[.[]/).filter(Boolean).pop() ?? '').replace(/\]$/, '');
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('.'), 0));

describe('phrase vs note keys', () => {
  it('the two sets are disjoint; a note is never in the ledger; citing one is refused with a pointer; a phrase renders verbatim', () => {
    for (const k of PHRASE_KEYS) expect(NOTE_KEYS.has(k), k).toBe(false);
    const ledger = new Ledger();
    ledger.add('r2', { verdict: { verdict: 'normal', reason: 'normal: 4 new…', basisClients: '4 new paying clients vs 4/week over 8 weeks (1.00×)' }, freshness: { line: 'data fresh — oldest connected source completed 30 min ago', phrase: 'data fresh' } }, T0, 'CAD');
    expect(ledger.get('r2:data.verdict.reason')).toBeUndefined();
    expect(ledger.get('r2:data.freshness.line')).toBeUndefined();
    expect(ledger.get('r2:data.verdict.basisClients')).toMatchObject({ unit: 'text' });
    expect(renderText('A {r2:data.verdict.verdict} week: {r2:data.verdict.basisClients} ({r2:data.freshness.phrase}).', ledger)).toBe('A normal week: 4 new paying clients vs 4/week over 8 weeks (1.00×) (data fresh).');
    expect(renderText('{r2:data.verdict.reason}', ledger)).toBe(NO_SOURCE);
    const a: Answer = { kind: 'answer', headline: { text: 'x' }, sections: [{ key: 'what_happened', body_md: 'Because {r2:data.verdict.reason} and {r2:data.freshness.line}.' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' };
    const v = verifyAnswer(a, ledger);
    expect(v.flagged.map((f) => f.reason)).toEqual([
      '"r2:data.verdict.reason" is explanatory text (reason) — not citeable; cite the numbers or the phrase beside it in your own words — the index has {r2:data.verdict.verdict}, {r2:data.verdict.basisClients}',
      '"r2:data.freshness.line" is explanatory text (line) — not citeable; cite the numbers or the phrase beside it in your own words — the index has {r2:data.freshness.phrase}',
    ]);
  });
  it('freshnessSummary: a citeable phrase beside the line, and the oldest age in minutes', () => {
    const base = { stale: false, staleSources: [], scheduler: { silent: false, detail: null }, sources: [] } as unknown as Parameters<typeof freshnessSummary>[0];
    const src = (key: string, label: string, ageHours: number | null, stale = false) => ({ key, label, configured: true, stale, ageHours, detail: null });
    expect(freshnessSummary({ ...base, sources: [src('ghl', 'GoHighLevel pipeline', 0.5), src('meta', 'Meta Ads spend', 0.25)] } as never)).toMatchObject({ phrase: 'data fresh', oldestAgeMinutes: 30 });
    expect(freshnessSummary({ ...base, stale: true, staleSources: [src('meta', 'Meta Ads spend', 9, true)], sources: [src('meta', 'Meta Ads spend', 9, true)] } as never)).toMatchObject({ phrase: 'Meta Ads spend stale for 9.0 h', oldestAgeMinutes: 540 });
    expect(freshnessSummary({ ...base, scheduler: { silent: true, detail: 'no cron call for 4 h' } } as never)).toMatchObject({ phrase: 'scheduler silent' });
    expect(freshnessSummary({ ...base, sources: [] } as never)).toMatchObject({ phrase: 'no sources connected', oldestAgeMinutes: null });
  });
});

describe('sweep: every phrase in every tool result is embeddable (demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  it('≤ 12 words, no trailing period, no " — " clause, never restating a sibling phrase — across all 15 tools', async () => {
    const freshness: Freshness = { stale: false, line: 'data fresh — oldest connected source completed 30 min ago', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] };
    const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
    const R = { preset: 'last_month', start: '', end: '' };
    const W = { preset: 'last_week', start: '', end: '' };
    const lc = await runAnalystTool('list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }, ctx('r0'));
    const id = (lc.data as { rows: Array<{ id: string }> }).rows[0].id;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_data_health', { range: W }], ['get_scorecard', { range: W, compare: 'previous_period' }], ['get_scorecard', { range: R, compare: 'previous_period' }], ['get_funnel', { range: R, mode: 'cohort' }], ['get_funnel', { range: R, mode: 'period' }],
      ['get_campaigns', { range: R, compare: 'previous_period' }], ['get_revenue', { range: R }],
      ['get_trend', { metric: 'paid_cac', window: '3m' }], ['get_trend', { metric: 'consult_show_rate', window: '3m' }],
      ['compare_periods', { range: R, against: W }], ['get_notes', {}], ['get_todo', {}],
      ['get_metric', { key: 'paid_cac', range: R, mode: 'period' }], ['get_metric', { key: 'week_verdict', range: W, mode: 'period' }], ['get_metric', { key: 'consult_show_rate', range: R, mode: 'period' }],
      ['list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }], ['get_client', { id }], ['get_stage_people', { range: R, stage: 'enrolled', mode: 'cohort', page: 1 }], ['get_payments', { range: R, page: 1, paymentClass: 'any', status: 'any' }],
    ];
    const bad: string[] = [];
    let phrases = 0;
    for (const [name, input] of calls) {
      const r = await runAnalystTool(name, input, ctx('r1'));
      expect(r.error, `${name}: ${r.error}`).toBeUndefined();
      const entries = ledgerEntries('r1', r.data, T0, r.currency).filter((e) => e.unit === 'text');
      const byParent = new Map<string, Array<{ key: string; text: string }>>();
      for (const e of entries) {
        const path = e.ref.slice(3);
        const list = byParent.get(parentOf(path)) ?? [];
        list.push({ key: lastKey(path), text: e.text ?? '' });
        byParent.set(parentOf(path), list);
      }
      for (const [parent, list] of byParent) {
        for (const { key, text } of list) {
          phrases += 1;
          const where = `${name} ${parent}.${key} = "${text}"`;
          if (words(text) > 12) bad.push(`${where}: ${words(text)} words`);
          if (/\.$/.test(text)) bad.push(`${where}: trailing period`);
          // Names come from the tenant's own data (a Meta campaign may be called "Summer Shred — Broad"); the clause rule is for FitFlow-written phrases.
          if (text.includes(' — ') && !['name', 'campaign', 'campaignName'].includes(key)) bad.push(`${where}: " — " clause`);
          for (const sib of list) if (sib.key !== key && sib.text && (text === sib.text || text.startsWith(`${sib.text}:`) || text.startsWith(`${sib.text}.`))) bad.push(`${where}: restates sibling ${sib.key}`);
        }
      }
    }
    expect(phrases).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });
});
