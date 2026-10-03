/**
 * Live conversation smoke (plan item 8): ONE question by default (item 7 — the
 * cheap check, target ≤ $0.50 USD); `--full` runs the whole conversation (a
 * follow-up, a budget question, the memory check, an explain) before a release.
 * Real API, real tools, in-memory store (nothing written). Prints per turn:
 *   PASS turn 1 · 3 tools · 18.2K in (15.9K cached) · 2.4K out · $0.19 USD · 21 s · estimate $0.31 USD
 * and states whether answers used output_config.format or submit_answer.
 */

import { executeTurn, prepareTurn, type TurnRequest } from './service';
import { MemoryAnalystStore } from './store';
import { costLine, type AnalystEvent, type TurnOutcome } from './run';
import { formatUsd } from './cost';
import { getAnalystConfig } from './config';
import { loopClient, makeAnalystClient } from './api';
import { analystWireHash, recordingClient, scrubFixture, writeFixture, type RecordedTurn, type ReplayFixture } from './replay';
import { loadPeople } from './scrubPeople';

export interface SmokeTurnLine {
  status: 'PASS' | 'FAIL';
  turn: number;
  question: string;
  tools: number;
  cost: string;
  estimateUsd: number | null;
  seconds: number;
  headline: string | null;
  flagged: number;
  /** Repair turns this turn took, counted from ITS OWN events (0 or 1). */
  repairs: number;
  /** The answer's note proposals (kept in memory by the smoke — nothing is written). */
  proposals: string[];
  sections: string[];
  error: string | null;
  cacheRead: number;
  /** Item 10: one entry per API request — tool calls it made and its cache share. */
  rounds: Array<{ toolCalls: number; cacheSharePct: number }>;
  costUsd: number;
  /** The per-turn targets this turn missed (empty on a PASS). */
  misses: string[];
}

/** Item 10: the targets per Opus chat turn (Mitchell, 2026-09-30; cost target raised to $0.50 on 2026-10-03). The deep model is reported, not judged. */
export const SMOKE_TARGETS = { p50Seconds: 45, maxUsd: 0.5, cacheSharePctFromRound2: 80, repairRateMax: 0.2, flaggedMax: 0, estimateTolerance: 0.25 } as const;

/** The per-turn misses (pure): cost, cache share from round 2, estimate accuracy. Seconds / repairs / flagged are judged across the run. */
export function turnMisses(l: Pick<SmokeTurnLine, 'costUsd' | 'estimateUsd' | 'rounds'>): string[] {
  const out: string[] = [];
  if (l.costUsd > SMOKE_TARGETS.maxUsd + 1e-9) out.push(`cost ${formatUsd(l.costUsd)} > ${formatUsd(SMOKE_TARGETS.maxUsd)}`);
  l.rounds.forEach((r, i) => {
    if (i >= 1 && r.cacheSharePct < SMOKE_TARGETS.cacheSharePctFromRound2) out.push(`cache round ${i + 1} ${r.cacheSharePct}% < ${SMOKE_TARGETS.cacheSharePctFromRound2}%`);
  });
  if (l.estimateUsd !== null && l.estimateUsd > 0) {
    const err = (l.costUsd - l.estimateUsd) / l.estimateUsd;
    if (Math.abs(err) > SMOKE_TARGETS.estimateTolerance + 1e-9) out.push(`estimate ${err > 0 ? '+' : ''}${Math.round(err * 100)}% outside ±${Math.round(SMOKE_TARGETS.estimateTolerance * 100)}%`);
  }
  return out;
}

/** The run-level verdict (pure): p50 seconds, repair rate, flagged across every PASS/FAIL line that ran. */
export function runMisses(lines: SmokeTurnLine[]): string[] {
  const ran = lines.filter((l) => l.seconds > 0);
  if (ran.length === 0) return [];
  const secs = ran.map((l) => l.seconds).sort((a, b) => a - b);
  const p50 = secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2;
  const repairs = ran.reduce((a, l) => a + l.repairs, 0);
  const flagged = ran.reduce((a, l) => a + l.flagged, 0);
  const out: string[] = [];
  if (p50 > SMOKE_TARGETS.p50Seconds) out.push(`p50 ${p50}s > ${SMOKE_TARGETS.p50Seconds}s`);
  if (repairs / ran.length >= SMOKE_TARGETS.repairRateMax) out.push(`repairs ${repairs}/${ran.length} turns ≥ ${Math.round(SMOKE_TARGETS.repairRateMax * 100)}%`);
  if (flagged > SMOKE_TARGETS.flaggedMax) out.push(`${flagged} flagged number(s) > ${SMOKE_TARGETS.flaggedMax}`);
  return out;
}

export interface SmokeTurn extends Omit<TurnRequest, 'clientTurnId'> {
  /** Item 6 (memory check): this turn states a durable fact — the answer must carry ≥ 1 note proposal. */
  expectsProposal?: boolean;
  /** The sections this answer must carry (2026-10-01: cheaper must not mean thinner — turn 1 stays 5/5). */
  expectsSections?: readonly string[];
}

/** "sections 4/5: missing so_what" when a required section is absent; null when all are there (pure). */
export function sectionsMiss(expected: readonly string[] | undefined, got: string[]): string | null {
  if (!expected?.length) return null;
  const missing = expected.filter((k) => !got.includes(k));
  return missing.length ? `sections ${expected.length - missing.length}/${expected.length}: missing ${missing.join(', ')}` : null;
}

export const SMOKE_TURNS: SmokeTurn[] = [
  { question: 'How did last week go, and what should we focus on this week?', kind: 'ask', context: { page: 'command_center', range: null, compare: 'previous_period' }, expectsSections: ['what_happened', 'why', 'so_what', 'do_this', 'how_we_will_know'] },
  { question: 'And how does that compare with the week before?', kind: 'ask' },
  { question: 'Which campaign had the best cost per client in that period, and should we move budget?', kind: 'ask' },
  { question: 'For the record: from October we cap Meta spend at $4,000 CAD a month. Does that change your advice?', kind: 'ask', expectsProposal: true },
  { question: '', kind: 'explain', explainKey: 'paid_cac', context: { page: 'ads', range: null } },
];

const pctOf = (l: SmokeTurnLine) => (l.estimateUsd && l.estimateUsd > 0 ? ` (${l.costUsd >= l.estimateUsd ? '+' : ''}${Math.round(((l.costUsd - l.estimateUsd) / l.estimateUsd) * 100)}%)` : '');

/**
 *   PASS turn 1 · 3 rounds · tools/round 4,1,0 · cache 0%/91%/95% · repairs 0 · flagged 0 · 38s · $0.33 USD vs est $0.41 USD (-20%) · sections …
 *        ↳ headline
 *   FAIL turn 2 · … · missed: cost $0.52 USD > $0.50 USD; cache round 2 71% < 80%
 */
export function formatSmokeTurn(l: SmokeTurnLine): string {
  const metrics = `${l.rounds.length} round${l.rounds.length === 1 ? '' : 's'} · tools/round ${l.rounds.map((r) => r.toolCalls).join(',') || '—'} · cache ${l.rounds.map((r) => `${Math.round(r.cacheSharePct)}%`).join('/') || '—'} · repairs ${l.repairs} · flagged ${l.flagged} · ${l.seconds}s · ${formatUsd(l.costUsd)}${l.estimateUsd !== null ? ` vs est ${formatUsd(l.estimateUsd)}${pctOf(l)}` : ''}`;
  if (l.status === 'FAIL') return `FAIL turn ${l.turn} · "${l.question || '(explain paid_cac)'}" · ${metrics}${l.error ? ` · ${l.error}` : ''}${l.misses.length ? ` · missed: ${l.misses.join('; ')}` : ''}`;
  return `PASS turn ${l.turn} · ${metrics} · sections ${l.sections.length} (${l.sections.join(',')})${l.proposals.length ? ` · ${l.proposals.length} note proposal(s): ${l.proposals.map((p) => `"${p}"`).join(' | ')}` : ''}\n     ↳ ${l.headline}`;
}

export interface SmokeOptions {
  log?: (line: string) => void;
  /** Item 7: the default run is ONE turn (target ≤ $0.50 USD); `full` runs the whole conversation — before a release only. */
  full?: boolean;
  /** Item 8: the hard USD budget for the whole run (default 1.00). Before every request, spent + the next request's estimate must fit. */
  maxUsd?: number;
  /** Item 9: keep every API response, tool result and log row as a replay fixture (tests/fixtures/analyst-replay/<name>.json). */
  record?: { name: string; database: string } | null;
}

export const DEFAULT_MAX_USD = 1;

/** "Stopped at $0.84 of $1.00 USD budget — the next request was estimated at $0.31 USD" */
export function budgetStopMessage(spentUsd: number, maxUsd: number, nextUsd: number | null): string {
  return `Stopped at ${formatUsd(spentUsd)} of ${formatUsd(maxUsd)} budget${nextUsd !== null ? ` — the next request was estimated at ${formatUsd(nextUsd)}` : ''}`;
}

/** Item 8 (pure): may the next request be sent? `spent + next` must stay within the budget. */
export function withinBudget(spentUsd: number, nextUsd: number, maxUsd: number): boolean {
  return spentUsd + nextUsd <= maxUsd + 1e-9;
}

/** `--max-usd 1.50` or `--max-usd=1.50`; a value that is not a positive number is refused, never defaulted silently. */
export function parseMaxUsd(args: string[]): number {
  const i = args.findIndex((a) => a === '--max-usd' || a.startsWith('--max-usd='));
  if (i < 0) return DEFAULT_MAX_USD;
  const raw = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) throw new Error(`--max-usd needs a positive USD amount, got "${raw ?? ''}"`);
  return n;
}

export const costUsdOf = (costLineText: string) => Number((/\$([\d.]+) USD$/.exec(costLineText) ?? [])[1] ?? 0);

/** The turns a run exercises: the first one by default, all of them with --full. */
export function smokeTurns(opts: Pick<SmokeOptions, 'full'>): SmokeTurn[] {
  return opts.full ? SMOKE_TURNS : SMOKE_TURNS.slice(0, 1);
}

export async function runAnalystSmoke(opts: SmokeOptions = {}): Promise<{ lines: SmokeTurnLine[]; ok: boolean; answerMode: string; model: string; turns: number; spentUsd: number; maxUsd: number; budgetStopped: boolean; runMisses: string[]; fixturePath: string | null; recordError: string | null; effort: string | null }> {
  const store = new MemoryAnalystStore();
  const config = await getAnalystConfig();
  const lines: SmokeTurnLine[] = [];
  const turns = smokeTurns(opts);
  const maxUsd = opts.maxUsd ?? DEFAULT_MAX_USD;
  let spentUsd = 0;
  let budgetStopped = false;
  let threadId: string | null = null;
  // Item 9: the recorder wraps the live client; prepareTurn uses the client it is given.
  const recorder = opts.record && config.key ? recordingClient(loopClient(makeAnalystClient(config.key))) : null;
  const recorded: RecordedTurn[] = [];
  let fixturePath: string | null = null;
  let recordError: string | null = null;
  let threadModel: string | null = null;
  let threadEffort: string | null = null;
  const fail = (turn: number, question: string, error: string, extra: Partial<SmokeTurnLine> = {}) => lines.push({ status: 'FAIL', turn, question, tools: 0, cost: '$0.00 USD', costUsd: 0, estimateUsd: null, seconds: 0, headline: null, flagged: 0, repairs: 0, proposals: [], sections: [], error, cacheRead: 0, rounds: [], misses: [], ...extra });
  for (let i = 0; i < turns.length; i++) {
    const req = turns[i];
    const started = Date.now();
    let tools = 0;
    let cacheRead = 0;
    const rounds: SmokeTurnLine['rounds'] = [];
    const onEvent = (e: AnalystEvent) => {
      if (e.type === 'tools') tools += e.calls.length;
      if (e.type === 'round') rounds.push({ toolCalls: e.toolCalls, cacheSharePct: e.cacheSharePct });
      if (e.type === 'usage') cacheRead = e.usage.cacheReadTokens;
      if (e.type === 'status') opts.log?.(`   turn ${i + 1} · ${e.text}`);
      if (e.type === 'tools') opts.log?.(`   turn ${i + 1} · ${e.calls.map((c) => `${c.ref} ${c.name}`).join(', ')}`);
    };
    // Nothing is written: proposals are collected here, not saved as notes.
    const proposals: string[] = [];
    const { expectsProposal: _expects, expectsSections: _sections, ...turnReq } = req;
    // The remaining budget is what this turn may spend: the cap decision refuses a turn whose estimate does not fit,
    // and the loop pauses between rounds (needs_confirmation) when spent + the next request would not — both read
    // here as the budget stop. Nothing is sent past the budget.
    const remaining = Math.max(0, maxUsd - spentUsd);
    recorder?.reset();
    const prepared = await prepareTurn({ ...turnReq, threadId, clientTurnId: `smoke-${i + 1}`, confirmedUsd: remaining }, { store, onEvent, client: recorder ?? undefined, onProposals: async (texts) => { proposals.push(...texts); return { saved: 0, skipped: texts.length }; } });
    if (!prepared.ok) {
      if (prepared.status === 'needs_confirmation') {
        budgetStopped = true;
        fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, prepared.estimate.usd), { estimateUsd: prepared.estimate.usd });
      } else fail(i + 1, req.question, prepared.message);
      break;
    }
    threadId = prepared.thread.id;
    threadModel = prepared.thread.model;
    threadEffort = prepared.thread.effort;
    // The per-run cap ($3) may admit a turn the smoke budget cannot: check here, before the first request is sent.
    if (!withinBudget(spentUsd, prepared.estimate.usd, maxUsd)) {
      budgetStopped = true;
      fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, prepared.estimate.usd), { estimateUsd: prepared.estimate.usd });
      break;
    }
    let out: TurnOutcome;
    try {
      out = await executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps);
    } catch (err) {
      fail(i + 1, req.question, err instanceof Error ? err.message : String(err), { tools, estimateUsd: prepared.estimate.usd, seconds: Math.round((Date.now() - started) / 1000), cacheRead, rounds });
      break;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const turn = await store.getTurn(prepared.turn.id);
    spentUsd += out.costUsd;
    if (out.status === 'needs_confirmation') {
      budgetStopped = true;
      fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, null), { tools, cost: costLine(out.usage, out.costUsd), costUsd: out.costUsd, estimateUsd: prepared.estimate.usd, seconds, cacheRead, rounds });
      break;
    }
    // Counted from this turn's own events, so the line and the "Repairing…" log lines above it agree.
    const repairs = turn?.events.filter((e) => e.type === 'status' && (e as { text?: string }).text === 'Repairing the answer…').length ?? 0;
    if (recorder && out.status === 'done') {
      const rows = (await store.listMessages(prepared.thread.id)).filter((r) => r.turnId === prepared.turn.id).map((r) => ({ role: r.role, apiJson: r.apiJson, display: r.display }));
      recorded.push({
        question: req.question,
        kind: req.kind,
        userTurn: prepared.deps.userTurn ?? '',
        freshness: prepared.deps.freshness,
        responses: [...recorder.responses],
        compactions: [...recorder.compactions],
        rows,
        outcome: { status: out.status, headline: out.answer?.headline.text ?? null, flagged: out.flagged, repairs, rounds: out.rounds, costUsd: out.costUsd, usage: out.usage, sections: out.answer?.sections.map((s) => s.key) ?? [], proposals },
      });
    }
    const memoryMiss = req.expectsProposal && proposals.length === 0;
    const thin = sectionsMiss(req.expectsSections, out.answer?.sections.map((s) => s.key) ?? []);
    // Item 10: the per-turn targets apply to the Opus model; the deep model's figures are printed, not judged.
    const judged = prepared.thread.model.startsWith('claude-opus');
    const misses = [...(judged ? turnMisses({ costUsd: out.costUsd, estimateUsd: prepared.estimate.usd, rounds }) : []), ...(thin ? [thin] : [])];
    lines.push({
      status: out.status === 'done' && out.answer && !memoryMiss && misses.length === 0 ? 'PASS' : 'FAIL',
      turn: i + 1,
      question: req.question,
      tools,
      cost: costLine(out.usage, out.costUsd),
      costUsd: out.costUsd,
      rounds,
      misses,
      estimateUsd: prepared.estimate.usd,
      seconds,
      headline: out.rendered?.headline ?? null,
      flagged: out.flagged.length,
      repairs,
      sections: out.answer?.sections.map((s) => s.key) ?? [],
      proposals,
      error: out.error ?? (out.status !== 'done' ? out.status : memoryMiss ? 'memory check: the owner stated a durable fact but the answer proposed no note' : null),
      cacheRead,
    });
    if (out.status !== 'done') break;
  }
  const model = threadId ? ((await store.getThread(threadId))?.model ?? config.modelDefault) : config.modelDefault;
  if (opts.record && recorder && recorded.length > 0 && threadModel && threadEffort) {
    // A fixture never holds real people: scrub names / emails / phones to stable placeholders, prove nobody from the
    // contacts table is left and that the scrubbed file still replays, and only then write it.
    const raw: ReplayFixture = { version: 1, recordedAt: new Date().toISOString(), wireHash: analystWireHash(config.answerMode), model: threadModel as ReplayFixture['model'], effort: threadEffort as ReplayFixture['effort'], answerMode: config.answerMode, database: opts.record.database, turns: recorded };
    try {
      const fixture = await scrubFixture(raw, await loadPeople());
      fixturePath = writeFixture(opts.record.name, fixture);
      opts.log?.(`   recorded ${recorded.length} turn${recorded.length === 1 ? '' : 's'} → ${fixturePath} (wire hash ${fixture.wireHash.slice(0, 12)}…; scrubbed: ${fixture.scrub!.people} people → Client A…, ${fixture.scrub!.names} name / ${fixture.scrub!.emails} email / ${fixture.scrub!.phones} phone replacements; checked against ${fixture.scrub!.checkedAgainst} people)`);
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err);
      opts.log?.(`   FAIL record · ${recordError}`);
    }
  }
  const runLevel = model.startsWith('claude-opus') ? runMisses(lines) : [];
  return { lines, ok: lines.length === turns.length && lines.every((l) => l.status === 'PASS') && runLevel.length === 0, answerMode: config.answerMode, model, turns: turns.length, spentUsd, maxUsd, budgetStopped, runMisses: runLevel, fixturePath, recordError, effort: threadEffort };
}
