/**
 * `npm run eval:analyst` — the golden eval (Analyst plan item 12 + amendment 3), READ-ONLY, in-memory store, the real
 * model with the stored key. Writes docs/eval-analyst-<date>.md. Every cost figure is USD (amendment 6).
 *
 *   --suite numbers|explain|behaviour|all   (default all)
 *   --max-usd 15                            the hard budget for the run (default 15): nothing is sent past it, a stop is a FAIL
 *   --skip-sources                          run the harness in engine mode only (no provider calls)
 *
 * 1. The acceptance harness runs first (lib/verify/harness.ts); any FAIL refuses the numbers suite, naming the check.
 * 2. numbers (25): the headline figure must equal the INDEPENDENT SQL (counts / cents exact, ratios ± 0.0005), 0 flagged;
 *    a case that fails and passes on its one re-run is reported FLAKY (counted as a pass, never silently). Threshold ≥ 24/25.
 * 3. explain (10 metrics × 2 ranges): exactly the three sections, the formula box = the engine, 0 flagged.
 * 4. behaviour (5): on the seeded DEMO tenant in a child process (an embedded database in memory, the key in its
 *    environment, nothing written): stale source → warning first and every spend decision a server hold; a healthy
 *    metric → no invented advice; an ambiguous question → one clarifying question; a 5-turn conversation keeps
 *    "that campaign"; a campaign-row question answers about that campaign.
 *
 * Needs CREDENTIALS_KEY in .env.local to decrypt a stored key. Exit 0 only when every suite meets its threshold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { runMigrations } from '../db/migrate';
import { DATABASE_URL, db, contacts } from '../db';
import { seedDemo } from '../db/seed-demo';
import { getAnalystConfig } from '../lib/analyst/config';
import { formatUsd } from '../lib/analyst/cost';
import { rebuildBrief } from '../lib/analyst/briefService';
import { recordTenantCheck } from '../lib/analyst/fixtureGuard';
import { newestMarkerAt } from '../lib/analyst/service';
import { EvalThread, type EvalTurnResult } from '../lib/analyst/evalRunner';
import { BEHAVIOUR_CASES, EXPLAIN_CASES, NUMBERS_QUESTIONS, type EvalRangeKey, type SqlOut } from '../lib/analyst/evalQuestions';
import { formatExpected, scoreCampaignRow, scoreClarify, scoreContext, scoreExplain, scoreHealthy, scoreNumbers, scoreStale, type Score } from '../lib/analyst/evalScore';
import { runVerify, VerifyRefused } from '../lib/verify/harness';
import { getTimezone, setSetting } from '../lib/settings';
import { resolvePreset, todayInTimezone } from '../lib/dates';
import { loadMetricsInput } from '../lib/metrics/load';
import { glossaryEntry } from '../lib/metrics/glossary';
import { writeMarker } from '../lib/sync/markers';
import type { ExplainInfo } from '../lib/analyst/prompts';

const EVAL_CHILD = 'FITFLOW_ANALYST_EVAL_CHILD';
const DEMO_CAMPAIGNS = ['Summer Shred — Broad', 'Summer Shred — Retargeting', 'Brand Search'] as const;

type Suite = 'numbers' | 'explain' | 'behaviour' | 'all';

interface CaseLine {
  suite: string;
  id: string;
  title: string;
  status: 'PASS' | 'FLAKY' | 'FAIL';
  got: string;
  expected: string;
  reason: string | null;
  costUsd: number;
  seconds: number;
}

function parseArgs(argv: string[]) {
  let suite: Suite = 'all';
  let maxUsd = 15;
  let skipSources = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') suite = (argv[++i] as Suite) ?? 'all';
    else if (a.startsWith('--suite=')) suite = a.slice(8) as Suite;
    else if (a === '--max-usd') maxUsd = Number(argv[++i]);
    else if (a.startsWith('--max-usd=')) maxUsd = Number(a.slice(10));
    else if (a === '--skip-sources') skipSources = true;
  }
  if (!['numbers', 'explain', 'behaviour', 'all'].includes(suite)) throw new Error(`unknown suite "${suite}"`);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`--max-usd must be a positive number`);
  return { suite, maxUsd, skipSources };
}

const line = (l: CaseLine) => `${l.status.padEnd(5)} ${l.suite} ${l.id} · ${l.title} · got ${l.got} · expected ${l.expected}${l.reason ? ` · ${l.reason}` : ''} · ${formatUsd(l.costUsd)} · ${l.seconds}s`;

class Budget {
  spent = 0;
  constructor(readonly max: number) {}
  get remaining() {
    return Math.max(0, this.max - this.spent);
  }
  add(usd: number) {
    this.spent += usd;
  }
  stopped(): boolean {
    return this.spent >= this.max;
  }
}

async function main() {
  const { suite, maxUsd, skipSources } = parseArgs(process.argv.slice(2));
  if (process.env[EVAL_CHILD]) return behaviourChild(maxUsd);
  await runMigrations();
  const config = await getAnalystConfig();
  if (!config.configured) {
    console.log(`SKIP · no Anthropic API key${process.env.CREDENTIALS_KEY ? '' : ' (a stored key needs CREDENTIALS_KEY in .env.local to decrypt)'} — nothing evaluated`);
    process.exit(1);
  }
  const tz = await getTimezone();
  const today = todayInTimezone(tz);
  const budget = new Budget(maxUsd);
  const lines: CaseLine[] = [];
  const log = (s: string) => console.log(s);
  log(`eval:analyst · ${suite} · budget ${formatUsd(maxUsd)} · model ${config.modelDefault} · database ${DATABASE_URL ? `postgres @ ${new URL(DATABASE_URL).hostname}` : 'embedded PGlite'}`);

  // 1. The harness first (amendment 3).
  let harness: Awaited<ReturnType<typeof runVerify>> | null = null;
  if (suite === 'numbers' || suite === 'all' || suite === 'explain') {
    log(`\nverify.ts (${skipSources ? 'engine' : 'all'}) …`);
    try {
      harness = await runVerify({ mode: skipSources ? 'engine' : 'all' });
    } catch (e) {
      console.error(e instanceof VerifyRefused ? e.message : e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    log(`verify: ${harness.passN} PASS · ${harness.pendingN} PENDING · ${harness.infoN} INFO · ${harness.failN} FAIL → ${path.relative(process.cwd(), harness.reportPath)}`);
    if (harness.failN > 0) {
      for (const c of harness.checks.filter((c) => c.status === 'FAIL')) log(`   FAIL ${c.section} · ${c.name} — ${c.detail}`);
      log('REFUSED · the numbers suite counts only when the harness reports 0 FAIL (amendment 3)');
      process.exit(1);
    }
  }

  // 2. numbers.
  const summary: Record<string, { pass: number; flaky: number; total: number; threshold: number }> = {};
  if ((suite === 'numbers' || suite === 'all') && harness) {
    const markerBefore = await newestMarkerAt();
    const ranges = Object.fromEntries(harness.ranges.map((r) => [r.key, r]));
    summary.numbers = { pass: 0, flaky: 0, total: NUMBERS_QUESTIONS.length, threshold: 24 };
    for (const q of NUMBERS_QUESTIONS) {
      if (budget.stopped()) {
        lines.push({ suite: 'numbers', id: q.id, title: q.metric, status: 'FAIL', got: '—', expected: '—', reason: `Stopped at ${formatUsd(budget.spent)} of ${formatUsd(maxUsd)} budget`, costUsd: 0, seconds: 0 });
        continue;
      }
      const S = harness.independentSql[q.range] as SqlOut;
      const expected = q.expected(S);
      const r = ranges[q.range as EvalRangeKey];
      const run = async (): Promise<{ score: Score; res: EvalTurnResult }> => {
        const thread = new EvalThread();
        const res = await thread.run({ question: q.question, kind: 'ask', context: { page: 'command_center', range: { start: r.start, end: r.end, label: r.label }, compare: 'previous_period' } }, { allowUsd: budget.remaining, log });
        budget.add(res.costUsd);
        const score = res.outcome ? scoreNumbers(res.outcome, res.rows, expected, q.unit) : { ok: false, got: res.message ?? 'no outcome', expected: formatExpected(expected, q.unit), reason: res.message };
        return { score, res };
      };
      log(`\n${q.id} · ${q.question}`);
      let { score, res } = await run();
      let status: CaseLine['status'] = score.ok ? 'PASS' : 'FAIL';
      let cost = res.costUsd;
      let secs = res.seconds;
      if (!score.ok && !budget.stopped()) {
        log(`   re-running once (${score.reason})`);
        const again = await run();
        cost += again.res.costUsd;
        secs += again.res.seconds;
        if (again.score.ok) {
          status = 'FLAKY';
          score = again.score;
        } else score = again.score;
      }
      if (status === 'PASS') summary.numbers.pass += 1;
      if (status === 'FLAKY') {
        summary.numbers.pass += 1;
        summary.numbers.flaky += 1;
      }
      const l: CaseLine = { suite: 'numbers', id: q.id, title: `"${q.question}" (${q.metric})`, status, got: score.got, expected: score.expected, reason: score.reason, costUsd: cost, seconds: secs };
      lines.push(l);
      log(line(l));
    }
    const markerAfter = await newestMarkerAt();
    if (markerBefore !== markerAfter) log(`\nnote: a sync marker moved during the numbers suite (${markerBefore} → ${markerAfter}); a FAIL may be timing — re-run the suite`);
  }

  // 3. explain.
  if ((suite === 'explain' || suite === 'all') && harness) {
    summary.explain = { pass: 0, flaky: 0, total: EXPLAIN_CASES.length, threshold: EXPLAIN_CASES.length };
    for (const c of EXPLAIN_CASES) {
      if (budget.stopped()) {
        lines.push({ suite: 'explain', id: c.id, title: `${c.metricKey} · ${c.range}`, status: 'FAIL', got: '—', expected: '—', reason: `Stopped at ${formatUsd(budget.spent)} of ${formatUsd(maxUsd)} budget`, costUsd: 0, seconds: 0 });
        continue;
      }
      const range = resolvePreset(c.range, today);
      const entry = glossaryEntry(c.metricKey)!;
      const input = await loadMetricsInput({ start: range.start, end: range.end, timezone: tz });
      const engine = entry.worked(input, range, 'period');
      log(`\n${c.id} · What does ${entry.label} mean? (${range.presetLabel} · ${range.resolvedLabel})`);
      const thread = new EvalThread();
      const res = await thread.run({ question: '', kind: 'explain', explainKey: c.metricKey, context: { page: 'command_center', range: { start: range.start, end: range.end, label: `${range.presetLabel} · ${range.resolvedLabel}` }, compare: 'previous_period', selected: { kind: 'metric', id: c.metricKey, label: entry.label } } }, { allowUsd: budget.remaining, log });
      budget.add(res.costUsd);
      const ev = res.events.find((e) => e.type === 'explain');
      const explainEvent: ExplainInfo | null = ev && ev.type === 'explain' ? (({ type: _t, ...rest }) => rest)(ev) : null;
      const score = res.outcome ? scoreExplain(res.outcome, explainEvent, { worked: engine.text, value: engine.value }) : { ok: false, got: res.message ?? 'no outcome', expected: engine.text, reason: res.message };
      if (score.ok) summary.explain.pass += 1;
      const l: CaseLine = { suite: 'explain', id: c.id, title: `${entry.label} · ${range.presetLabel}`, status: score.ok ? 'PASS' : 'FAIL', got: score.got, expected: score.expected, reason: score.reason, costUsd: res.costUsd, seconds: res.seconds };
      lines.push(l);
      log(line(l));
    }
  }

  // 4. behaviour — in a child on the demo tenant.
  if (suite === 'behaviour' || suite === 'all') {
    summary.behaviour = { pass: 0, flaky: 0, total: BEHAVIOUR_CASES.length, threshold: BEHAVIOUR_CASES.length };
    log('\nbehaviour · on the demo tenant (a child process: embedded database in memory, seeded, the key in its environment; nothing written)');
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--suite', 'behaviour', '--max-usd', String(Math.max(0.5, budget.remaining))], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, [EVAL_CHILD]: '1', PGLITE_DATA_DIR: 'memory', DATABASE_URL: '', ANTHROPIC_API_KEY: config.key ?? '' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const raw of (child.stdout ?? '').split('\n')) {
      if (raw.startsWith('EVAL_RESULT ')) {
        const l = JSON.parse(raw.slice(12)) as CaseLine;
        lines.push(l);
        budget.add(l.costUsd);
        if (l.status !== 'FAIL') summary.behaviour.pass += 1;
        log(line(l));
      } else if (raw.trim()) log(raw);
    }
    if (child.status !== 0 && !lines.some((l) => l.suite === 'behaviour')) lines.push({ suite: 'behaviour', id: 'b0', title: 'the child process', status: 'FAIL', got: `exit ${child.status}`, expected: 'exit 0', reason: 'the demo-tenant child did not run', costUsd: 0, seconds: 0 });
  }

  // Report.
  const totals = Object.entries(summary).map(([k, v]) => `${k} ${v.pass}/${v.total}${v.flaky ? ` (${v.flaky} flaky)` : ''}`).join(' · ');
  const ok = Object.values(summary).every((v) => v.pass >= v.threshold) && !lines.some((l) => l.reason?.startsWith('Stopped at'));
  const reportPath = path.join(process.cwd(), 'docs', `eval-analyst-${today}.md`);
  const md = [
    `# FitFlow Analyst eval — ${today}`,
    '',
    `Generated by \`npm run eval:analyst -- --suite ${suite}\` at ${new Date().toISOString()} (business timezone ${tz}, model ${config.modelDefault}). Read-only: the in-memory store, nothing written; the behaviour suite ran on the seeded demo tenant.`,
    '',
    `**${ok ? 'PASS' : 'FAIL'}** — ${totals} · ${formatUsd(budget.spent)} of ${formatUsd(maxUsd)} budget. Thresholds: numbers ≥ 24/25, explain 20/20, behaviour 5/5. FLAKY = failed once, passed on the re-run (counted, never silent).`,
    '',
    ...(harness ? [`Harness first (amendment 3): ${harness.passN} PASS · ${harness.pendingN} PENDING · ${harness.infoN} INFO · ${harness.failN} FAIL — \`${path.relative(process.cwd(), harness.reportPath)}\`.`, ''] : []),
    ...Object.keys(summary).flatMap((s) => [`## ${s}`, '', '| | Case | Got | Expected | Reason | Cost | Time |', '|---|---|---|---|---|---|---|', ...lines.filter((l) => l.suite === s).map((l) => `| ${l.status === 'FAIL' ? '**FAIL**' : l.status} | ${l.id} · ${l.title.replace(/\|/g, '\\|')} | ${l.got.replace(/\|/g, '\\|')} | ${l.expected.replace(/\|/g, '\\|')} | ${(l.reason ?? '').replace(/\|/g, '\\|')} | ${formatUsd(l.costUsd)} | ${l.seconds}s |`), '']),
  ].join('\n');
  fs.writeFileSync(reportPath, md);
  log(`\n${ok ? 'PASS' : 'FAIL'} · ${totals} · ${formatUsd(budget.spent)} of ${formatUsd(maxUsd)} budget → ${path.relative(process.cwd(), reportPath)}`);
  process.exit(ok ? 0 : 1);
}

/** The behaviour suite, inside the child: seed the demo tenant, build its brief, run the cases, print one JSON line each. */
async function behaviourChild(maxUsd: number) {
  await runMigrations();
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(contacts).where(sql`${contacts.origin} <> 'demo'`);
  const check = recordTenantCheck({ databaseUrl: DATABASE_URL, nonDemoContacts: Number(n) });
  if (!check.ok) {
    console.log(`FAIL behaviour · ${check.reason}`);
    process.exit(1);
  }
  await seedDemo({ log: (l) => console.log(`   seed · ${l.trim()}`) });
  await rebuildBrief({ trigger: 'manual', countTokens: false });
  const budget = new Budget(maxUsd);
  const emit = (l: CaseLine) => console.log(`EVAL_RESULT ${JSON.stringify(l)}`);
  const stopped = (c: { id: string; title: string }) => emit({ suite: 'behaviour', id: c.id, title: c.title, status: 'FAIL', got: '—', expected: '—', reason: `Stopped at ${formatUsd(budget.spent)} of ${formatUsd(maxUsd)} budget`, costUsd: 0, seconds: 0 });
  // b1 runs on the freshly seeded tenant, which has never had a scheduled run: stale by construction ("scheduler silent").
  for (const c of BEHAVIOUR_CASES) {
    if (c.kind !== 'stale' && c.id === 'b2') {
      // From here the tenant is fresh: a scheduler run and every marker just now.
      await setSetting('scheduler_last_run', JSON.stringify({ route: '/api/cron/dispatch', at: new Date().toISOString(), via: 'other' }));
      for (const family of ['ghl.opportunities', 'ghl.appointments', 'ghl.mirrors', 'meta.spend', 'stripe.payments', 'stripe.completeness'] as const) await writeMarker({ family, runId: null, fetched: 0, detail: 'eval: marked fresh' });
    }
    if (budget.stopped()) {
      stopped(c);
      continue;
    }
    const thread = new EvalThread();
    const outcomes: NonNullable<EvalTurnResult['outcome']>[] = [];
    let firstEvents: Array<{ type: string; stale?: boolean }> = [];
    let cost = 0;
    let secs = 0;
    let failed: string | null = null;
    for (const t of c.turns) {
      const res = await thread.run({ question: t.question, kind: t.kind ?? 'ask', explainKey: t.explainKey ?? null, context: { page: t.selected ? 'ads' : 'command_center', range: null, compare: 'previous_period', selected: t.selected ?? null } }, { allowUsd: budget.remaining });
      budget.add(res.costUsd);
      cost += res.costUsd;
      secs += res.seconds;
      if (!firstEvents.length) firstEvents = res.events.map((e) => ({ type: e.type, stale: e.type === 'notice' ? e.stale : undefined }));
      if (!res.outcome || res.outcome.status !== 'done') {
        failed = res.message ?? res.outcome?.status ?? 'no outcome';
        break;
      }
      outcomes.push(res.outcome);
    }
    let score: Score;
    if (failed) score = { ok: false, got: failed, expected: 'every turn done', reason: failed };
    else if (c.kind === 'stale') score = scoreStale(outcomes, firstEvents);
    else if (c.kind === 'healthy') score = scoreHealthy(outcomes);
    else if (c.kind === 'clarify') score = scoreClarify(outcomes);
    else if (c.kind === 'context') score = scoreContext(outcomes, DEMO_CAMPAIGNS);
    else score = scoreCampaignRow(outcomes, c.turns[0].selected?.label ?? '');
    emit({ suite: 'behaviour', id: c.id, title: c.title, status: score.ok ? 'PASS' : 'FAIL', got: score.got, expected: score.expected, reason: score.reason, costUsd: cost, seconds: Math.round(secs * 10) / 10 });
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`FAIL eval:analyst · ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
