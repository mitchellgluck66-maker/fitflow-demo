/**
 * Oct 7 item 2b: every number the model can read inside a tool result's text (a note, a reason, a phrase) also
 * exists as a numeric leaf it can cite — in the same object, an ancestor, the result's `constants` or its `range`
 * — so restating "90%", "7 days" or "2 of 64" never needs a raw digit. Dates, week labels and years are not
 * numbers. Sweeps all 15 tools on the demo tenant.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { runAnalystTool, CONSTANTS, type Freshness, type ToolContext } from '@/lib/analyst/tools';

const DATE_LIKE = /\d{4}-\d{2}-\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(\s?[–-]\s?(\d{1,2}|[a-z]{3,}\.? \d{1,2}))?|\b20\d\d\b|\d{1,2}:\d{2}/gi;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** The numeric leaves an object (and the chain above it) exposes, as the values a text could show. */
function candidates(chain: Array<Record<string, unknown>>): Set<number> {
  const out = new Set<number>();
  const push = (v: number) => {
    out.add(v);
    out.add(Math.round(v * 1000) / 10); // a 0–1 share shown as a percentage (one decimal)
    out.add(Math.round(v * 100)); // … or a whole percentage
    out.add(Math.round(v * 100) / 100);
    out.add(Math.round(v / 100)); // cents shown as dollars (rounded)
    out.add(Math.round(v / 100 * 100) / 100);
    out.add(Math.round(v * 100) / 100 / 1); // a multiple at two decimals
  };
  for (const o of chain) for (const v of Object.values(o)) if (typeof v === 'number' && Number.isFinite(v)) push(v);
  return out;
}

/** The text the model reads for figures: notes, reasons, phrases, labels, the worked formula. Ids, links, docs references and policy prose are not. */
const TEXT_KEYS = new Set(['note', 'reason', 'text', 'summary', 'phrase', 'basis', 'basisClients', 'basisCash', 'withheld', 'label', 'worked', 'line']);
/** The numeric-bearing child objects of an object (a `coverage` or `inputs` block beside the note). */
function childObjects(o: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.values(o).filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v));
}

describe('sweep: every number inside a text leaf has a numeric leaf beside it (demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  it('across all 15 tools', async () => {
    const freshness: Freshness = { stale: false, line: 'data fresh — oldest connected source completed 30 min ago', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] };
    const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
    const R = { preset: 'last_month', start: '', end: '' };
    const W = { preset: 'last_week', start: '', end: '' };
    const lc = await runAnalystTool('list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }, ctx('r0'));
    const id = (lc.data as { rows: Array<{ id: string }> }).rows[0].id;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_data_health', { range: W }], ['get_scorecard', { range: W, compare: 'previous_period' }], ['get_scorecard', { range: R, compare: 'previous_period' }], ['get_funnel', { range: R, mode: 'cohort' }], ['get_funnel', { range: R, mode: 'period' }],
      ['get_campaigns', { range: R, compare: 'previous_period' }], ['get_revenue', { range: R }], ['get_trend', { metric: 'paid_cac', window: '3m' }], ['get_trend', { metric: 'consult_show_rate', window: '3m' }],
      ['compare_periods', { range: R, against: W }], ['get_notes', {}], ['get_todo', {}],
      ['get_metric', { key: 'paid_cac', range: R, mode: 'period' }], ['get_metric', { key: 'week_verdict', range: W, mode: 'period' }], ['get_metric', { key: 'consult_show_rate', range: R, mode: 'period' }], ['get_metric', { key: 'spend_gate', range: W, mode: 'period' }],
      ['list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }], ['get_client', { id }], ['get_stage_people', { range: R, stage: 'enrolled', mode: 'cohort', page: 1 }], ['get_payments', { range: R, page: 1, paymentClass: 'any', status: 'any' }],
    ];
    const bad: string[] = [];
    let checked = 0;
    for (const [name, input] of calls) {
      const r = await runAnalystTool(name, input, ctx('r1'));
      expect(r.error, `${name}: ${r.error}`).toBeUndefined();
      const root = r.data as Record<string, unknown>;
      const global = candidates([CONSTANTS as unknown as Record<string, unknown>, (r.range ?? {}) as Record<string, unknown>, (root.constants ?? {}) as Record<string, unknown>]);
      const walk = (v: unknown, chain: Array<Record<string, unknown>>, path: string) => {
        if (typeof v === 'string') {
          const key = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? '';
          if (!TEXT_KEYS.has(key)) return;
          const text = v.replace(DATE_LIKE, ' ');
          const have = new Set([...global, ...candidates(chain), ...candidates(childObjects(chain[chain.length - 1] ?? {}))]);
          for (const m of text.match(NUMBER) ?? []) {
            const n = Number(m.replace(/,/g, ''));
            if (!Number.isFinite(n)) continue;
            checked += 1;
            if (!have.has(n) && !have.has(Math.round(n * 100) / 100)) bad.push(`${name} ${path} = "${v}" → ${m} has no numeric leaf beside it`);
          }
          return;
        }
        if (path === 'data.decisions') return; // the decisions log is policy prose (definitions), not figures
        if (Array.isArray(v)) return v.forEach((x, i) => walk(x, chain, `${path}[${i}]`));
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          for (const [k, x] of Object.entries(o)) walk(x, [...chain, o], `${path}.${k}`);
        }
      };
      walk(root, [], 'data');
    }
    expect(checked).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
