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
import { costLine, countRepairs, type AnalystEvent, type RepairProblem, type TurnOutcome } from './run';
import type { PrefixState } from './cost';
import { SECTION_LABELS } from './schema';
import type { RenderedAnswer } from './render';
import { SNAPSHOT_PREFIX } from './starter';
import { formatSplit, formatUsd, type CostSplit } from './cost';
import { getAnalystConfig } from './config';
import { loopClient, makeAnalystClient, type BetaTool } from './api';
import type { AnalystModel } from './config';
import { approxPrefix, formatPrefixLine, measurePrefix, type PrefixParts, type PrefixPieces } from './prefixBudget';
import { starterMessages } from './starter';
import type { NewMessage } from './store';
import { analystWireHash, recordingClient, writeFixture, type RecordedTurn, type ReplayFixture } from './replay';
import { nonDemoNames } from './fixtureGuard';
import { spendDecisionsLine } from './spendDecisions';

export interface SmokeTurnLine {
  status: 'PASS' | 'FAIL';
  turn: number;
  question: string;
  tools: number;
  cost: string;
  estimateUsd: number | null;
  /** Oct 4 item 5: how the estimate priced the prefix; printed beside the measured hit / written. */
  estimatePrefix?: PrefixState | null;
  /** Oct 7 item 1: the answer's spend actions ("spend: hold Scaling, hold Testing" / "spend: none"). */
  spend?: string;
  /** Oct 7 item 2a: the costliest repair round's share of the turn (null when no repair). */
  repairSharePct?: number | null;
  /** Oct 7 item 6: review (a week / period review) or metric (one figure, an explain); sets the p50 target. */
  shape?: 'review' | 'metric';
  /** Oct 7 item 6: seconds to the first verified section in the stream (null when none streamed). */
  firstSectionSeconds?: number | null;
  seconds: number;
  headline: string | null;
  flagged: number;
  /** Repair turns this turn took, counted from ITS OWN events (0 or 1). */
  repairs: number;
  /** Item 4: the rule behind each problem of the repair turn(s), counted by kind (digits × 2, ref × 1 …). */
  repairKinds?: Record<string, number>;
  /** The answer's note proposals (kept in memory by the smoke — nothing is written). */
  proposals: string[];
  sections: string[];
  error: string | null;
  cacheRead: number;
  /** Item 10: one entry per API request — tool calls it made and its cache share. */
  rounds: Array<{ toolCalls: number; cacheSharePct: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  costUsd: number;
  /** Item D. */
  split: CostSplit | null;
  /** The per-turn targets this turn missed (empty on a PASS). */
  misses: string[];
}

/** Item 10: the targets per Opus chat turn (Mitchell, 2026-09-30; cost target raised to $0.50 on 2026-10-03). The deep model is reported, not judged. */
export const SMOKE_TARGETS = { /** Oct 7 item 6 (Mitchell): p50 of the full answer per question shape, and the first verified section per turn. */ p50Seconds: { review: 90, metric: 45 }, firstSectionSeconds: 20, /** Oct 7 item 5: judged by the turn's MEASURED prefix state (a cold turn pays the 1h prefix write). */ maxUsd: { cold: 0.6, warm: 0.45 }, cacheSharePctFromRound2: 80, repairRateMax: 0.2, /** Oct 7 item 2a: a repair round costs less than this share of its turn. */ repairSharePctMax: 20, flaggedMax: 0, estimateTolerance: 0.25 } as const;

/** The per-turn misses (pure): cost (by prefix state), cache share from round 2, estimate accuracy. Seconds / repairs / flagged are judged across the run. */
export function turnMisses(l: Pick<SmokeTurnLine, 'costUsd' | 'estimateUsd' | 'rounds'> & { repairSharePct?: number | null; firstSectionSeconds?: number | null }): string[] {
  const out: string[] = [];
  if (typeof l.firstSectionSeconds === 'number' && l.firstSectionSeconds > SMOKE_TARGETS.firstSectionSeconds) out.push(`first section ${l.firstSectionSeconds}s > ${SMOKE_TARGETS.firstSectionSeconds}s`);
  if (typeof l.repairSharePct === 'number' && l.repairSharePct >= SMOKE_TARGETS.repairSharePctMax) out.push(`repair cost ${l.repairSharePct}% of the turn ≥ ${SMOKE_TARGETS.repairSharePctMax}%`);
  const state = measuredPrefix(l.rounds) ?? 'cold';
  if (l.costUsd > SMOKE_TARGETS.maxUsd[state] + 1e-9) out.push(`cost ${formatUsd(l.costUsd)} > ${formatUsd(SMOKE_TARGETS.maxUsd[state])} (${state})`);
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
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

export function runMisses(lines: SmokeTurnLine[]): string[] {
  const ran = lines.filter((l) => l.seconds > 0);
  if (ran.length === 0) return [];
  const repairs = ran.reduce((a, l) => a + l.repairs, 0);
  const flagged = ran.reduce((a, l) => a + l.flagged, 0);
  const out: string[] = [];
  // Oct 7 item 6: p50 of the full answer per question shape (review ≤ 90 s, single-metric ≤ 45 s).
  for (const shape of ['review', 'metric'] as const) {
    const secs = ran.filter((l) => (l.shape ?? 'review') === shape).map((l) => l.seconds);
    if (secs.length && median(secs) > SMOKE_TARGETS.p50Seconds[shape]) out.push(`p50 (${shape}) ${median(secs)}s > ${SMOKE_TARGETS.p50Seconds[shape]}s`);
  }
  if (repairs / ran.length >= SMOKE_TARGETS.repairRateMax) out.push(`repairs ${repairs}/${ran.length} turns ≥ ${Math.round(SMOKE_TARGETS.repairRateMax * 100)}%`);
  if (flagged > SMOKE_TARGETS.flaggedMax) out.push(`${flagged} flagged number(s) > ${SMOKE_TARGETS.flaggedMax}`);
  return out;
}

export interface SmokeTurn extends Omit<TurnRequest, 'clientTurnId'> {
  /** Item 6 (memory check): this turn states a durable fact — the answer must carry ≥ 1 note proposal. */
  expectsProposal?: boolean;
  /** The sections this answer must carry (2026-10-01: cheaper must not mean thinner — turn 1 stays 5/5). */
  expectsSections?: readonly string[];
  /** Oct 7 item 6: the question's shape — a review (p50 ≤ 90 s) or a single-metric question / explain (p50 ≤ 45 s). */
  shape: 'review' | 'metric';
  /** 1b (2026-10-06): the rendered headline must carry the SERVER's verdict word for last week (strong / normal / weak), never the model's own. */
  expectsVerdict?: boolean;
}

/** The snapshot's verdict (r2) from a new thread's starter row, or null when the thread has none. */
export function starterVerdict(rows: ReadonlyArray<{ apiJson: string }> | null | undefined): { verdict: string; reason: string } | null {
  for (const r of rows ?? []) {
    const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; text?: string }> };
    for (const b of msg.content ?? []) {
      if (b.type !== 'text' || !b.text?.startsWith(SNAPSHOT_PREFIX)) continue;
      try {
        const res = JSON.parse(b.text.slice(SNAPSHOT_PREFIX.length)) as { data?: { verdict?: { verdict: string; reason: string } } };
        if (res.data?.verdict) return { verdict: res.data.verdict.verdict, reason: res.data.verdict.reason };
      } catch {
        /* not a tool result */
      }
    }
  }
  return null;
}

/** Oct 7 item 1: the spend gates from the starter snapshot (r2), printed so two runs are comparable line by line. */
export function starterGates(rows: ReadonlyArray<{ apiJson: string }> | null | undefined): string | null {
  for (const r of rows ?? []) {
    const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; text?: string }> };
    for (const b of msg.content ?? []) {
      if (b.type !== 'text' || !b.text?.startsWith(SNAPSHOT_PREFIX)) continue;
      try {
        const res = JSON.parse(b.text.slice(SNAPSHOT_PREFIX.length)) as { data?: { spendGates?: { account: { campaign: string; decision: string; basis: string }; campaigns: Array<{ campaign: string; decision: string; basis: string }> } } };
        const g = res.data?.spendGates;
        if (g) return `spend gates: ${[g.account, ...g.campaigns].map((x) => `${x.campaign} ${x.decision === 'may_change' ? 'may change' : 'hold'} (${x.basis})`).join(' · ')}`;
      } catch {
        /* not a tool result */
      }
    }
  }
  return null;
}

/** "spend: hold account, hold Scaling*" / "spend: none" — the server's spend decisions in gate order (spendDecisions.ts). */
export { spendDecisionsLine as spendLine } from './spendDecisions';

/** "headline verdict ≠ computed verdict: the headline says "strong", the server computed normal" — or null. */
export function verdictMiss(expected: { verdict: string } | null, headline: string | null): string | null {
  if (!expected || !headline) return null;
  const words = (headline.match(/\b(strong|normal|weak)\b/gi) ?? []).map((w) => w.toLowerCase());
  if (expected.verdict === 'unavailable') return words.length ? `headline verdict ≠ computed verdict: the headline says "${words[0]}", the server computed unavailable` : null;
  if (!words.includes(expected.verdict)) return `headline verdict ≠ computed verdict: the headline says "${words[0] ?? '(no verdict word)'}", the server computed ${expected.verdict}`;
  return null;
}

/** "sections 4/5: missing so_what" when a required section is absent; null when all are there (pure). */
export function sectionsMiss(expected: readonly string[] | undefined, got: string[]): string | null {
  if (!expected?.length) return null;
  const missing = expected.filter((k) => !got.includes(k));
  return missing.length ? `sections ${expected.length - missing.length}/${expected.length}: missing ${missing.join(', ')}` : null;
}

export const SMOKE_TURNS: SmokeTurn[] = [
  { question: 'How did last week go, and what should we focus on this week?', kind: 'ask', shape: 'review', context: { page: 'command_center', range: null, compare: 'previous_period' }, expectsSections: ['what_happened', 'why', 'so_what', 'do_this', 'how_we_will_know'], expectsVerdict: true },
  { question: 'And how does that compare with the week before?', kind: 'ask', shape: 'review' },
  { question: 'Which campaign had the best cost per client in that period, and should we move budget?', kind: 'ask', shape: 'metric' },
  { question: 'For the record: from October we cap Meta spend at $4,000 CAD a month. Does that change your advice?', kind: 'ask', shape: 'review', expectsProposal: true },
  { question: '', kind: 'explain', shape: 'metric', explainKey: 'paid_cac', context: { page: 'ads', range: null } },
];

const pctOf = (l: SmokeTurnLine) => (l.estimateUsd && l.estimateUsd > 0 ? ` (${l.costUsd >= l.estimateUsd ? '+' : ''}${Math.round(((l.costUsd - l.estimateUsd) / l.estimateUsd) * 100)}%)` : '');

/**
 *   PASS turn 1 · 3 rounds · tools/round 4,1,0 · cache 0%/91%/95% · repairs 1 (digits×2, ref×1) · flagged 0 · first section 14s · total 38s · $0.33 USD vs est $0.41 USD (cold) (-20%) · sections …
 *        ↳ headline
 *   FAIL turn 2 · … · missed: cost $0.52 USD > $0.50 USD; cache round 2 71% < 80%
 */
/** Oct 4 item 5: the prefix state the first round measured (hit = read from cache; written), or null before any round. */
export function measuredPrefix(rounds: SmokeTurnLine['rounds']): PrefixState | null {
  const first = rounds[0];
  return first ? (first.cacheReadTokens > 0 ? 'warm' : 'cold') : null;
}

/** " · prefix predicted cold, measured hit" when the estimate's prefix state and the first round disagree; else "". Printed, never hidden. */
export function prefixMismatchLine(l: Pick<SmokeTurnLine, 'estimatePrefix' | 'rounds'>): string {
  const measured = measuredPrefix(l.rounds);
  if (!l.estimatePrefix || !measured || measured === l.estimatePrefix) return '';
  return ` · prefix predicted ${l.estimatePrefix}, measured ${measured === 'warm' ? 'hit' : 'written'}`;
}

/** Item C: did the first request of the turn read the stable prefix from cache, or write it? */
export function prefixLine(rounds: SmokeTurnLine['rounds']): string {
  const first = rounds[0];
  if (!first) return 'prefix: —';
  const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
  return first.cacheReadTokens > 0 ? `prefix: hit (${k(first.cacheReadTokens)} read)` : `prefix: written (${k(first.cacheWriteTokens)}, 1h on Opus)`;
}

/** " (digits×2, ref×1)" — the kinds behind a turn's repairs, most frequent first; empty when there were none. */
export function repairKindsLine(kinds: Record<string, number> | undefined): string {
  const entries = Object.entries(kinds ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? ` (${entries.map(([k, n]) => `${k}×${n}`).join(', ')})` : '';
}

/** The repair problems of a turn, from its own events, in order. */
export function repairProblems(events: ReadonlyArray<AnalystEvent>): RepairProblem[] {
  return events.flatMap((e) => (e.type === 'repair' ? e.problems : []));
}

export function repairKinds(problems: readonly RepairProblem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of problems) out[p.kind] = (out[p.kind] ?? 0) + 1;
  return out;
}

/**
 * The repair rounds of a turn (Oct 7 item 2a): each repair event with the cost of the round that answered it
 * (the next `round` event) and its share of the turn's total.
 */
export function repairRounds(events: ReadonlyArray<AnalystEvent>): Array<{ targeted: boolean; paths: string[]; problems: RepairProblem[]; costUsd: number; sharePct: number | null }> {
  const total = events.reduce((a, e) => (e.type === 'round' ? a + e.costUsd : a), 0);
  const out: Array<{ targeted: boolean; paths: string[]; problems: RepairProblem[]; costUsd: number; sharePct: number | null }> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'repair') continue;
    const round = events.slice(i + 1).find((x) => x.type === 'round');
    const costUsd = round && round.type === 'round' ? round.costUsd : 0;
    out.push({ targeted: e.targeted, paths: e.paths, problems: e.problems, costUsd, sharePct: total > 0 ? Math.round((costUsd / total) * 100) : null });
  }
  return out;
}

/** One line per repair problem, then the repair's cost: `repair 1 · targeted (what_happened) · $0.04 (11% of the turn)`. */
export function formatRepairs(events: ReadonlyArray<AnalystEvent>, indent = '   '): string[] {
  const out: string[] = [];
  repairRounds(events).forEach((r, i) => {
    for (const p of r.problems) out.push(`${indent}repair ${i + 1} · ${p.kind} (${p.section})${p.text ? `: "${p.text}"` : ''} — ${p.reason}`);
    out.push(`${indent}repair ${i + 1} · ${r.targeted ? `targeted (${r.paths.join(', ')})` : 'full regeneration'} · ${formatUsd(r.costUsd)}${r.sharePct === null ? '' : ` (${r.sharePct}% of the turn)`}`);
  });
  return out;
}

export function formatSmokeTurn(l: SmokeTurnLine): string {
  const metrics = `${l.rounds.length} round${l.rounds.length === 1 ? '' : 's'} · tools/round ${l.rounds.map((r) => r.toolCalls).join(',') || '—'} · cache ${l.rounds.map((r) => `${Math.round(r.cacheSharePct)}%`).join('/') || '—'} · ${prefixLine(l.rounds)} · repairs ${l.repairs}${repairKindsLine(l.repairKinds)} · flagged ${l.flagged} · first section ${l.firstSectionSeconds === null || l.firstSectionSeconds === undefined ? '—' : `${l.firstSectionSeconds}s`} · total ${l.seconds}s · ${formatUsd(l.costUsd)}${l.estimateUsd !== null ? ` vs est ${formatUsd(l.estimateUsd)}${l.estimatePrefix ? ` (${l.estimatePrefix})` : ''}${pctOf(l)}` : ''}${prefixMismatchLine(l)}`;
  // The spend decisions print on BOTH outcomes: the ship gate "identical spend: lines across runs" (2026-10-15) is judged
  // from this line even when a non-blocking target (cost, latency, repair share) marks the turn FAIL.
  if (l.status === 'FAIL') return `FAIL turn ${l.turn} · "${l.question || '(explain paid_cac)'}" · ${metrics}${l.spend ? ` · ${l.spend}` : ''}${l.error ? ` · ${l.error}` : ''}${l.misses.length ? ` · missed: ${l.misses.join('; ')}` : ''}`;
  return `PASS turn ${l.turn} · ${metrics} · sections ${l.sections.length} (${l.sections.join(',')})${l.spend ? ` · ${l.spend}` : ''}${l.proposals.length ? ` · ${l.proposals.length} note proposal(s): ${l.proposals.map((p) => `"${p}"`).join(' | ')}` : ''}\n     ↳ ${l.headline}`;
}

/**
 * The full rendered answer as the owner would read it (G, 2026-10-03): headline, every section whole (no
 * truncation), actions, findings, note proposals — printed on every run so the answer is reviewed for
 * quality, not just its metrics line.
 */
export function formatRenderedAnswer(r: RenderedAnswer, indent = '   '): string {
  const lines: string[] = [];
  lines.push(`${indent}┌ ${r.kind.toUpperCase()} · ${r.headline}`);
  for (const s of r.sections) {
    lines.push(`${indent}│`);
    lines.push(`${indent}│ ## ${SECTION_LABELS[s.key] ?? s.key}`);
    for (const l of s.body_md.split('\n')) lines.push(`${indent}│ ${l}`);
  }
  if (r.kind === 'clarify' && r.clarifying_question) lines.push(`${indent}│ ? ${r.clarifying_question}`);
  if (r.actions.length) {
    lines.push(`${indent}│`);
    lines.push(`${indent}│ ## Actions`);
    r.actions.forEach((a, i) => lines.push(`${indent}│ ${i + 1}. [${a.kind}${a.gate ? ` · gate ${a.gate === 'may_change' ? 'may change' : 'hold'} · ${a.decidedBy === 'server' ? 'server' : 'model'}` : ''} · ${a.owner} · ${a.confidence}] ${a.action} — ${a.why} · impact: ${a.expected_impact} · watch ${a.metric} on ${a.check_date}`));
  }
  if (r.findings.length) {
    lines.push(`${indent}│`);
    lines.push(`${indent}│ ## Findings`);
    for (const f of r.findings) lines.push(`${indent}│ • [${f.area} · ${f.metric} · ${f.direction} · ${f.severity}] ${f.finding}${f.evidence_refs.length ? ` (${f.evidence_refs.join(', ')})` : ''}`);
  }
  if (r.note_proposals.length) {
    lines.push(`${indent}│`);
    lines.push(`${indent}│ ## Note proposals`);
    for (const n of r.note_proposals) lines.push(`${indent}│ ○ ${n}`);
  }
  lines.push(`${indent}└`);
  return lines.join('\n');
}

export interface SmokeOptions {
  log?: (line: string) => void;
  /** Item 7: the default run is ONE turn (target ≤ $0.50 USD); `full` runs the whole conversation — before a release only. */
  full?: boolean;
  /** Item 8: the hard USD budget for the whole run (default 1.00). Before every request, spent + the next request's estimate must fit. */
  maxUsd?: number;
  /** Item 9: keep every API response, tool result and log row as a replay fixture (tests/fixtures/analyst-replay/<name>.json). Only on the demo tenant. */
  record?: { name: string; database: string } | null;
}

export const DEFAULT_MAX_USD = 1;

/** Oct 7 item 5: the cold prefix per piece — measured with count_tokens when a key is configured, else approximated. */
async function prefixForSmoke(prepared: { thread: { model: AnalystModel }; deps: { contract: string; brief: { text: string }; tools: readonly { definition: BetaTool }[]; starterRows?: NewMessage[] | null; userTurn?: string } }, key: string | null): Promise<PrefixPieces> {
  const parts: PrefixParts = { contract: prepared.deps.contract, brief: prepared.deps.brief.text, tools: prepared.deps.tools.map((t) => t.definition), messages: prepared.deps.starterRows ? starterMessages(prepared.deps.starterRows) : [{ role: 'user', content: prepared.deps.userTurn ?? '' }] };
  if (!key) return approxPrefix(parts);
  const client = makeAnalystClient(key);
  try {
    return await measurePrefix(prepared.thread.model, parts, async (params) => (await client.beta.messages.countTokens(params)).input_tokens);
  } catch {
    return approxPrefix(parts);
  }
}

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
  const fail = (turn: number, question: string, error: string, extra: Partial<SmokeTurnLine> = {}) => lines.push({ status: 'FAIL', turn, question, tools: 0, cost: '$0.00 USD', costUsd: 0, split: null, estimateUsd: null, seconds: 0, headline: null, flagged: 0, repairs: 0, proposals: [], sections: [], error, cacheRead: 0, rounds: [], misses: [], ...extra });
  for (let i = 0; i < turns.length; i++) {
    const req = turns[i];
    const started = Date.now();
    let tools = 0;
    let cacheRead = 0;
    const rounds: SmokeTurnLine['rounds'] = [];
    const onEvent = (e: AnalystEvent) => {
      if (e.type === 'tools') tools += e.calls.length;
      if (e.type === 'round') rounds.push({ toolCalls: e.toolCalls, cacheSharePct: e.cacheSharePct, cacheReadTokens: e.cacheReadTokens, cacheWriteTokens: e.cacheWriteTokens });
      if (e.type === 'usage') cacheRead = e.usage.cacheReadTokens;
      if (e.type === 'status') opts.log?.(`   turn ${i + 1} · ${e.text}`);
      if (e.type === 'tools') opts.log?.(`   turn ${i + 1} · ${e.calls.map((c) => `${c.ref} ${c.name}`).join(', ')}`);
    };
    // Nothing is written: proposals are collected here, not saved as notes.
    const proposals: string[] = [];
    const { expectsProposal: _expects, expectsSections: _sections, expectsVerdict: _verdict, shape: _shape, ...turnReq } = req;
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
    if (i === 0) opts.log?.(`   ${formatPrefixLine(await prefixForSmoke(prepared, config.key))}`);
    let out: TurnOutcome;
    try {
      out = await executeTurn(prepared.thread.id, prepared.turn.id, prepared.deps);
    } catch (err) {
      fail(i + 1, req.question, err instanceof Error ? err.message : String(err), { tools, estimateUsd: prepared.estimate.usd, estimatePrefix: prepared.estimate.prefix, seconds: Math.round((Date.now() - started) / 1000), cacheRead, rounds });
      break;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (out.rendered) opts.log?.(formatRenderedAnswer(out.rendered));
    for (const f of out.flagged) opts.log?.(`   flagged · ${f.kind} · ${f.section} · ${f.text} · ${f.reason}`);
    if (out.split) opts.log?.(`   cost split · ${formatSplit(out.split)}`);
    const turn = await store.getTurn(prepared.turn.id);
    spentUsd += out.costUsd;
    if (out.status === 'needs_confirmation') {
      budgetStopped = true;
      fail(i + 1, req.question, budgetStopMessage(spentUsd, maxUsd, null), { tools, cost: costLine(out.usage, out.costUsd), costUsd: out.costUsd, estimateUsd: prepared.estimate.usd, estimatePrefix: prepared.estimate.prefix, seconds, cacheRead, rounds });
      break;
    }
    // Counted from this turn's own events, so the line and the repair lines above it agree.
    const turnEvents = (turn?.events ?? []) as AnalystEvent[];
    const repairs = countRepairs(turnEvents);
    for (const line of formatRepairs(turnEvents)) opts.log?.(line);
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
    const computed = starterVerdict(prepared.deps.starterRows);
    if (computed) opts.log?.(`   verdict (computed by the server): ${computed.verdict} — ${computed.reason}`);
    const gatesText = starterGates(prepared.deps.starterRows);
    if (gatesText) opts.log?.(`   ${gatesText}`);
    const wrongVerdict = req.expectsVerdict ? verdictMiss(computed, out.rendered?.headline ?? null) : null;
    // Item 10: the per-turn targets apply to the Opus model; the deep model's figures are printed, not judged.
    const judged = prepared.thread.model.startsWith('claude-opus');
    const repairShare = repairRounds(turnEvents).reduce<number | null>((a, r) => (r.sharePct === null ? a : a === null ? r.sharePct : Math.max(a, r.sharePct)), null);
    const misses = [...(judged ? turnMisses({ costUsd: out.costUsd, estimateUsd: prepared.estimate.usd, rounds, repairSharePct: repairShare, firstSectionSeconds: out.firstSectionSeconds }) : []), ...(thin ? [thin] : []), ...(wrongVerdict ? [wrongVerdict] : [])];
    lines.push({
      status: out.status === 'done' && out.answer && !memoryMiss && misses.length === 0 ? 'PASS' : 'FAIL',
      turn: i + 1,
      question: req.question,
      tools,
      cost: costLine(out.usage, out.costUsd),
      costUsd: out.costUsd,
      split: out.split,
      rounds,
      misses,
      estimateUsd: prepared.estimate.usd,
      estimatePrefix: prepared.estimate.prefix,
      seconds,
      headline: out.rendered?.headline ?? null,
      flagged: out.flagged.length,
      repairs,
      repairKinds: repairKinds(repairProblems(turnEvents)),
      spend: out.answer ? spendDecisionsLine(out.spendDecisions) : undefined,
      repairSharePct: repairShare,
      shape: req.shape,
      firstSectionSeconds: out.firstSectionSeconds,
      sections: out.answer?.sections.map((s) => s.key) ?? [],
      proposals,
      error: out.error ?? (out.status !== 'done' ? out.status : memoryMiss ? 'memory check: the owner stated a durable fact but the answer proposed no note' : null),
      cacheRead,
    });
    if (out.status !== 'done') break;
  }
  const model = threadId ? ((await store.getThread(threadId))?.model ?? config.modelDefault) : config.modelDefault;
  if (opts.record && recorder && recorded.length > 0 && threadModel && threadEffort) {
    // Recorded against the demo tenant only (the script refuses anything else); the guard below is the belt and braces.
    const fixture: ReplayFixture = { version: 1, recordedAt: new Date().toISOString(), wireHash: analystWireHash(config.answerMode), model: threadModel as ReplayFixture['model'], effort: threadEffort as ReplayFixture['effort'], answerMode: config.answerMode, database: opts.record.database, tenant: 'demo', turns: recorded };
    const strangers = nonDemoNames(fixture);
    if (strangers.length) {
      recordError = `the recording holds ${strangers.length} name(s) the demo tenant cannot produce (first at ${strangers[0].path}) — nothing written`;
      opts.log?.(`   FAIL record · ${recordError}`);
    } else {
      fixturePath = writeFixture(opts.record.name, fixture);
      opts.log?.(`   recorded ${recorded.length} turn${recorded.length === 1 ? '' : 's'} → ${fixturePath} (demo tenant; wire hash ${fixture.wireHash.slice(0, 12)}…)`);
    }
  }
  const runLevel = model.startsWith('claude-opus') ? runMisses(lines) : [];
  return { lines, ok: lines.length === turns.length && lines.every((l) => l.status === 'PASS') && runLevel.length === 0, answerMode: config.answerMode, model, turns: turns.length, spentUsd, maxUsd, budgetStopped, runMisses: runLevel, fixturePath, recordError, effort: threadEffort };
}
