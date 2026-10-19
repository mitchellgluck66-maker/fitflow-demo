/**
 * The acceptance harness as a function (Wave 2 item 12 / amendment 3): `runVerify` runs in-process on the seeded demo
 * tenant (engine mode: the engine vs the independent SQL, no provider calls), returns every check and the SQL's `out`
 * JSON per range, and writes its report where it is told — so the eval can run it first and refuse on a FAIL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { runVerify, type VerifyResult } from '@/lib/verify/harness';
import { NUMBERS_QUESTIONS, showRateFromSql, type SqlOut } from '@/lib/analyst/evalQuestions';

describe('runVerify (engine mode, demo tenant)', () => {
  let r: VerifyResult;
  let dir: string;
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitflow-verify-'));
    r = await runVerify({ mode: 'engine', docsDir: dir });
  }, 180_000);

  it('returns every check, the counts and the engine / SQL payloads, and writes the report into the given folder', () => {
    expect(r.mode).toBe('engine');
    expect(r.timezone).toBe('America/Edmonton');
    expect(r.ranges.map((x) => x.key)).toEqual(['week', 'month', 'mtd', 'jul16']);
    expect(r.checks.find((c) => c.section === 'Engine vs SQL')?.detail).toMatch(/\d+ PASS · \d+ FAIL/);
    expect(r.passN + r.pendingN + r.infoN + r.failN).toBe(r.checks.length);
    expect(fs.existsSync(r.reportPath)).toBe(true);
    expect(r.reportPath.startsWith(dir)).toBe(true);
    expect(fs.existsSync(path.join(r.outDir, 'compare.txt'))).toBe(true);
    for (const k of r.ranges.map((x) => x.key)) {
      expect(r.engine[k]).toBeDefined();
      expect(r.independentSql[k]).toBeDefined();
    }
  });

  it('the demo tenant is a tenant: the engine and the independent SQL agree on every figure (0 FAIL)', () => {
    // Until 2026-10-18 the seed showed 26–50 differences, all three of one class — the SQL kept rules the engine had
    // moved past: has_stripe read origin = stripe (the engine's "awaiting Stripe" is NO payment rows at all), LTV:CAC
    // was withheld while ANY contract value was missing (the engine applies the partial-data rule), and a demo
    // applicant was dated by the contact's creation (a manual late entry sits 30 days before its application, on the
    // wrong side of the Jul 16 boundary). One rule for every origin now; the count must be 0, not "reported".
    const compare = fs.readFileSync(path.join(r.outDir, 'compare.txt'), 'utf8').split('\n');
    const failing = compare.filter((l) => l.startsWith('FAIL'));
    expect(failing, failing.join('\n')).toEqual([]);
    expect(compare.some((l) => l.startsWith('PASS'))).toBe(true);
    expect(r.failN).toBe(0);
  });

  it('every numbers question resolves against the SQL JSON, and wherever the harness found SQL = engine, the question\'s expected value IS that figure', () => {
    expect(NUMBERS_QUESTIONS).toHaveLength(25);
    expect(new Set(NUMBERS_QUESTIONS.map((q) => q.id)).size).toBe(25);
    // compare.txt: "PASS  week   CAD  funnel.period.applied   sql=43  app=43"
    const passed = new Map<string, number | null>();
    for (const l of fs.readFileSync(path.join(r.outDir, 'compare.txt'), 'utf8').split('\n')) {
      const m = /^PASS\s+(\w+)\s+(\S+)\s+(.+?)\s+sql=(\S+)\s+app=(\S+)$/.exec(l);
      if (m && m[2] === 'CAD') passed.set(`${m[1]}|${m[3].trim()}`, m[5] === 'null' ? null : Number(m[5]));
    }
    expect(passed.size).toBeGreaterThan(100);
    const label: Record<string, string> = {
      'applied (in period)': 'funnel.period.applied',
      'consults booked (in period)': 'funnel.period.consult_booked',
      'roadmaps booked (in period)': 'funnel.period.roadmap_booked',
      enrollments: 'enrollments',
      'consult booked (cohort)': 'funnel.cohort.consult_booked',
      'roadmap booked (cohort)': 'funnel.cohort.roadmap_booked',
      'enrolled (cohort)': 'funnel.cohort.enrolled',
      spend: 'spendCents',
      'Paid CAC': 'paidCacCents',
      'Blended CAC': 'blendedCacCents',
      'cost per roadmap': 'costPerRoadmapCents',
      'initial cash': 'initialCents',
      'recurring cash': 'revenue.recurringCents',
      collected: 'revenue.collectedCents',
      refunds: 'revenue.refundedCents',
      'failed payments': 'revenue.failedCount',
      ROAS: 'roas (paid initial ÷ spend)',
      'consult show rate': 'showRate.Consult.rate (≥90% coverage)',
    };
    let checked = 0;
    for (const q of NUMBERS_QUESTIONS) {
      const S = r.independentSql[q.range] as SqlOut;
      const v = q.expected(S);
      expect(v === null || Number.isFinite(v), `${q.id}: ${String(v)}`).toBe(true);
      const key = `${q.range}|${label[q.metric]}`;
      if (!passed.has(key)) continue;
      const app = passed.get(key)!;
      if (q.unit === 'ratio') expect(v === null ? null : Math.round(v * 10_000), `${q.id} (${q.metric})`).toBe(app === null ? null : Math.round(app * 10_000));
      else expect(v, `${q.id} (${q.metric})`).toBe(app);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
    const rate = showRateFromSql(r.independentSql.jul16 as SqlOut, 'Consult');
    expect(rate === null || (rate >= 0 && rate <= 1)).toBe(true);
  });
});

/**
 * "Now" pinned to a week boundary (2026-10-18): the harness crashed on a Sunday — last week's SQL had no enrollment, so
 * its `enrolled_by_att` was null and n07 (Paid CAC) read `.paid` of null — and the suspicion was week boundaries in UTC
 * against the business zone. Both instants below are MONDAY in UTC and still SUNDAY in Edmonton: today must be the
 * business zone's Sunday, last week Oct 11–17, every question's expected value a number or null, and the engine and
 * the SQL equal on every figure.
 */
describe('runVerify with now pinned to a week boundary', () => {
  const pins = [
    { name: 'Sunday evening in Edmonton (Monday 02:30 UTC)', now: new Date('2026-10-19T02:30:00Z') },
    { name: 'Monday early UTC (Sunday 18:10 in Edmonton)', now: new Date('2026-10-19T00:10:00Z') },
  ];
  for (const pin of pins) {
    it(pin.name, async () => {
      await runMigrations();
      await seedDemo();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitflow-verify-pin-'));
      const r = await runVerify({ mode: 'engine', docsDir: dir, now: pin.now });
      expect(r.today).toBe('2026-10-18');
      expect(r.ranges.find((x) => x.key === 'week')).toMatchObject({ start: '2026-10-11', end: '2026-10-17' });
      expect(r.ranges.find((x) => x.key === 'mtd')).toMatchObject({ start: '2026-10-01', end: '2026-10-18' });
      expect(r.failN, r.checks.filter((c) => c.status === 'FAIL').map((c) => c.detail).join('; ')).toBe(0);
      for (const q of NUMBERS_QUESTIONS) {
        const v = q.expected(r.independentSql[q.range] as SqlOut);
        expect(v === null || Number.isFinite(v), `${q.id}: ${String(v)}`).toBe(true);
      }
    }, 240_000);
  }
});
