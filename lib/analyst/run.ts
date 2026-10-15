/**
 * The agent loop (plan item 5): stream → tools → stream, to a verified
 * structured answer, over the append-only log. The runtime rules, each with a
 * test in tests/analyst-run.test.ts:
 *
 *   1. One append-only log; a round's assistant message and its tool results
 *      are written in one transaction, so the log always ends replayable.
 *      Unfinished, refused or cut-off assistant turns are never stored.
 *   2. The prefix is frozen (contract, brief, tools); everything volatile is in
 *      the user turn. drop_block is always set; a dropped block is logged.
 *   3. A number is shown only by ref: the model writes {r2:data.…} tokens and the
 *      server renders them (lib/analyst/render.ts); the verifier (verify.ts)
 *      checks the refs, raw digits and direction words — one repair turn, then
 *      what is still wrong is shown marked, never silently.
 *   4. Stale data is decided by the server: the notice is the first event; a
 *      spend action on stale data is repaired, then stripped with a reason.
 *   5. The run is not the connection: progress is stored on the turn; Stop is
 *      explicit; past the time budget the turn persists and emits `continue`.
 *   6. Cost: estimated and capped before spending, re-checked between rounds.
 */

import Anthropic from '@anthropic-ai/sdk';
import { assistantTurn, buildCompactionRequest, buildRepairRequest, buildTurnRequest, cacheSharePct, inputTransformations, progressUpdates, SUBMIT_ANSWER_TOOL, SUBMIT_REPAIR_TOOL, type BetaMessage, type BetaMessageParam, type BetaTool } from './api';
import { isTransientError, describeError, RETRY_DELAY_MS } from '../anthropic/client';
import { noteAnthropicOutcome } from '../anthropic/incident';
import { ANSWER_SCHEMA, AnswerSchema, checkStructure, REPAIR_SCHEMA, RepairSchema, spliceFields, TARGETED_KINDS, type Answer, type RepairFields } from './schema';
import { Ledger } from './ledger';
import { repairMessage, targetedRepairMessage, verifyAnswer, type Flag } from './verify';
import { completedSections } from './partial';
import { renderAnswer, renderText, type RenderedAnswer } from './render';
import { applySpendDecisions, type SpendDecision } from './spendDecisions';
import { formatUsd, priceUsage, shouldPause, splitUsage, usageTotals, type CostSplit, type UsageLike, type UsageTotals } from './cost';
import { runAnalystTool, type AnalystTool, type Freshness, type ToolResult } from './tools';
import { COMPACTION_INSTRUCTIONS } from './prompts';
import { SNAPSHOT_PREFIX } from './starter';
import type { AnalystStore, MessageRow, NewMessage, TurnRow } from './store';
import type { AnalystModel, AnswerMode, Effort } from './config';

/** Why an answer was sent back: the verifier's flag kinds, a structure failure, or a spend action on stale data. */
export type RepairKind = Flag['kind'] | 'structure' | 'stale_spend';
export interface RepairProblem {
  kind: RepairKind;
  section: string;
  text: string;
  reason: string;
}

/** Repair turns a turn took, from its own events (the `repair` event; the status line for a turn stored before it existed). */
export function countRepairs(events: ReadonlyArray<Record<string, unknown>>): number {
  const marked = events.filter((e) => e.type === 'repair').length;
  return marked || events.filter((e) => e.type === 'status' && e.text === 'Repairing the answer…').length;
}

export type AnalystEvent =
  | { type: 'notice'; text: string; stale: boolean }
  | { type: 'status'; text: string }
  /** Item 4 (2026-10-06): a repair turn, with every problem that triggered it and the rule each came from. Oct 7 item 2a: `targeted` = only the listed fields are asked for and spliced back; otherwise the whole answer is regenerated. */
  | { type: 'repair'; problems: RepairProblem[]; targeted: boolean; paths: string[] }
  /** One per streamed API response (diagnostics: the probe reads cache hits, dropped thinking, progress updates). */
  | { type: 'round'; stopReason: string | null; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; /** cacheRead ÷ (input + cacheRead + cacheWrite), % (item 2: ≥ 80 from round 2 is the target). */ cacheSharePct: number; outputTokens: number; droppedThinking: number; progressUpdates: number; toolCalls: number; /** Oct 7 item 2a: this round's price, so a repair round's share of the turn is measurable. */ costUsd: number; /** Wave 2 tune-up 3: this request's wall time, and the time to its first streamed content (thinking or text). */ seconds: number; firstTokenSeconds: number | null }
  | { type: 'tools'; calls: Array<{ ref: string; name: string; label: string }> }
  /** Oct 7 item 6: the first section of the answer completed in the stream and was verified at once — what the owner will see first (Wave 2 streams it). */
  | { type: 'section'; key: string; verified: boolean; seconds: number; /** Wave 2 tune-up 3: the section's position and its body RENDERED from the ledger (flags marked), so the panel shows it the moment it closes. */ index: number; body_md: string }
  | { type: 'answer'; answer: Answer; /** The answer as the owner reads it: every ref token rendered from the ledger (design review 2026-10-03, A). */ rendered: RenderedAnswer; flagged: Flag[]; repaired: boolean; /** How many repair turns this turn took (0 or 1 — the loop allows one). */ repairs: number; strippedSpendActions: number; /** Wave 2 tune-up 1: one spend decision per gate row, in gate order (the server's, or the model's on a may_change row). */ spendDecisions: SpendDecision[]; /** Oct 7 item 6: seconds from the turn's start to the first verified section in the stream (null when none streamed). */ firstSectionSeconds: number | null }
  | { type: 'usage'; usage: UsageTotals; costUsd: number; model: string; rounds: number; estimated: boolean; /** Item D: input · cache read · cache write · thinking · answer. */ split: CostSplit }
  | { type: 'continue' }
  | { type: 'needs_confirmation'; reason: string; spentUsd: number }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'stopped' }
  | { type: 'done'; status: 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'continue' };

/** The slice of the SDK the loop uses, so tests can hand it a fake stream. */
export interface AnalystClient {
  beta: {
    messages: {
      stream: (params: ReturnType<typeof buildTurnRequest>) => AsyncIterable<Anthropic.Beta.Messages.BetaRawMessageStreamEvent> & { finalMessage(): Promise<BetaMessage> };
      create: (params: ReturnType<typeof buildCompactionRequest>) => Promise<BetaMessage>;
    };
  };
}

export interface RunDeps {
  store: AnalystStore;
  client: AnalystClient;
  contract: string;
  brief: { text: string; hash: string };
  tools: readonly AnalystTool[];
  freshness: Freshness;
  /** The newest sync-marker time: a ref fetched before it is stale (re-fetch). */
  staleBefore?: string | null;
  /** The user turn text for a NEW turn (ignored on resume: the log already has it). */
  userTurn?: string;
  /** Item 4: on a NEW thread, the server-fetched snapshot rows that open the log (they carry the user turn). */
  starterRows?: NewMessage[] | null;
  /** USD the owner allowed for this run (the cap, or a confirmed amount). */
  allowedUsd: number;
  now?: () => number;
  /** Past this much wall time the loop persists and emits `continue` (default 240 s). */
  budgetMs?: number;
  maxRounds?: number;
  maxTokens?: number;
  /** Compact after a completed turn whose last request exceeded this many input tokens (default 300K). */
  compactAboveTokens?: number;
  retryDelayMs?: number;
  /** Item D: measures the visible output (answer text + tool calls) for the cost split; without it the split is ≈ chars ÷ 3.5 and says so. */
  countTokens?: (text: string) => Promise<number>;
  onEvent?: (e: AnalystEvent) => void;
  /** Item 6: where a finished answer's `note_proposals` go (the service saves them as proposed notes; the smoke keeps them in memory). */
  onProposals?: (texts: string[]) => Promise<{ saved: number; skipped: number }>;
}

export interface TurnOutcome {
  status: 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'continue';
  answer: Answer | null;
  /** The rendered answer (null when there is none). */
  rendered: RenderedAnswer | null;
  flagged: Flag[];
  usage: UsageTotals;
  costUsd: number;
  rounds: number;
  error: string | null;
  compacted: boolean;
  /** Item D (done turns only). */
  split: CostSplit | null;
  /** Oct 7 item 6: seconds to the first verified section in the stream (null when none streamed). */
  firstSectionSeconds: number | null;
  /** Wave 2 tune-up 1: the spend decisions (empty when the answer carried none or the turn did not finish). */
  spendDecisions: SpendDecision[];
}

const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens, cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens };
}

/** Rebuild the API history from the log: from the last compaction row on. */
export function historyFromLog(rows: MessageRow[]): { messages: BetaMessageParam[]; carriesCompaction: boolean } {
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'compaction') { start = i; break; }
  const slice = rows.slice(start);
  return { messages: slice.map((r) => JSON.parse(r.apiJson) as BetaMessageParam), carriesCompaction: slice[0]?.role === 'compaction' };
}

/** Rebuild the ledger from the log's tool-result rows (every row, compaction or not — refs never expire by compaction). */
export function ledgerFromLog(rows: MessageRow[]): { ledger: Ledger; calls: number } {
  const ledger = new Ledger();
  let calls = 0;
  for (const r of rows) {
    if (r.role !== 'tool_results') continue;
    const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; content?: string; text?: string }> };
    for (const b of msg.content ?? []) {
      // A tool_result block, or a starter snapshot block (item 4: a text block carrying a ToolResult after SNAPSHOT_PREFIX).
      const json = b.type === 'tool_result' && typeof b.content === 'string' ? b.content : b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(SNAPSHOT_PREFIX) ? b.text.slice(SNAPSHOT_PREFIX.length) : null;
      if (json === null) continue;
      calls += 1;
      try {
        const res = JSON.parse(json) as ToolResult;
        if (res && typeof res.ref === 'string') ledger.add(res.ref, res.data, r.createdAt.toISOString(), res.currency ?? 'CAD');
      } catch {
        /* an unparseable result contributes no refs */
      }
    }
  }
  return { ledger, calls };
}

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  get_scorecard: (i) => `Reading the scorecard${rangeText(i)}…`,
  get_funnel: (i) => `Reading the funnel${rangeText(i)} (${String(i.mode ?? 'period')})…`,
  get_stage_people: (i) => `Listing the people at ${String(i.stage ?? 'the stage')}…`,
  get_campaigns: (i) => `Reading the campaign table${rangeText(i)}…`,
  get_revenue: (i) => `Reading revenue${rangeText(i)}…`,
  get_payments: (i) => `Listing payments${rangeText(i)}…`,
  get_trend: (i) => `Reading the ${String(i.metric ?? 'metric')} trend over ${String(i.window ?? '3m')}…`,
  list_clients: () => 'Searching clients…',
  get_client: () => 'Opening a client profile…',
  get_data_health: () => 'Checking data health…',
  compare_periods: () => 'Comparing the two periods…',
  get_notes: () => 'Reading the owner notes…',
  get_metric: (i) => `Working the ${String(i.key ?? 'metric')} formula…`,
  get_todo: () => "Reading today's call list…",
  calculate: (i) => `Calculating (${Array.isArray(i.operations) ? `${i.operations.length} operation${i.operations.length === 1 ? '' : 's'}` : 'arithmetic'})…`,
};

function rangeText(i: Record<string, unknown>): string {
  const r = i.range as { preset?: string | null; start?: string | null; end?: string | null } | undefined;
  if (!r) return '';
  if (r.preset) return ` for ${r.preset.replace(/_/g, ' ')}`;
  if (r.start && r.end) return ` for ${r.start} – ${r.end}`;
  return '';
}

export function toolLabel(name: string, input: unknown): string {
  const f = TOOL_LABELS[name];
  return f ? f((input && typeof input === 'object' ? input : {}) as Record<string, unknown>) : `Running ${name}…`;
}

function answerFromMessage(message: BetaMessage, mode: AnswerMode): { answer: Answer | null; problem: string | null } {
  let raw: unknown;
  if (mode === 'submit_answer') {
    const block = message.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === SUBMIT_ANSWER_TOOL);
    if (!block) return { answer: null, problem: 'the turn ended without calling submit_answer — call it with the structured answer' };
    raw = block.input;
  } else {
    const text = message.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    if (!text.trim()) return { answer: null, problem: 'the turn ended with no answer text' };
    try {
      raw = JSON.parse(text);
    } catch {
      return { answer: null, problem: 'the answer was not valid JSON' };
    }
  }
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { answer: null, problem: `the answer failed validation at ${issue?.path.join('.') || '(root)'}: ${issue?.message}` };
  }
  return { answer: parsed.data, problem: null };
}

/** The fields a targeted repair returned (Oct 7 item 2a), or the problem. */
function repairFromMessage(message: BetaMessage, mode: AnswerMode): { fields: RepairFields | null; problem: string | null } {
  let raw: unknown;
  if (mode === 'submit_answer') {
    const block = message.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === SUBMIT_REPAIR_TOOL);
    if (!block) return { fields: null, problem: 'the repair ended without calling submit_repair' };
    raw = block.input;
  } else {
    const text = message.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    if (!text.trim()) return { fields: null, problem: 'the repair returned no text' };
    try {
      raw = JSON.parse(text);
    } catch {
      return { fields: null, problem: 'the repair was not valid JSON' };
    }
  }
  const parsed = RepairSchema.safeParse(raw);
  if (!parsed.success) return { fields: null, problem: `the repair failed validation at ${parsed.error.issues[0]?.path.join('.') || '(root)'}: ${parsed.error.issues[0]?.message}` };
  return { fields: parsed.data.fields, problem: null };
}

export async function runAnalystTurn(threadId: string, turnId: string, deps: RunDeps): Promise<TurnOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? 240_000;
  const maxRounds = deps.maxRounds ?? 16;
  const store = deps.store;
  const emit = async (e: AnalystEvent) => {
    await store.appendEvent(turnId, e as unknown as Record<string, unknown>);
    deps.onEvent?.(e);
  };

  const outcome = (status: TurnOutcome['status'], extra: Partial<TurnOutcome> = {}): TurnOutcome => ({ status, answer: null, rendered: null, flagged: [], usage, costUsd, rounds, error: null, compacted: false, split: null, firstSectionSeconds, spendDecisions: [], ...extra });
  let usage = emptyUsage();
  let costUsd = 0;
  let rounds = 0;

  const thread = await store.getThread(threadId);
  const turn = await store.getTurn(turnId);
  if (!thread || !turn) return outcome('failed', { error: 'thread or turn not found' });
  if (turn.status !== 'running') return outcome(turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : turn.status === 'failed' ? 'failed' : 'needs_confirmation', { error: turn.error });
  usage = turn.usage ? { inputTokens: turn.usage.inputTokens ?? 0, outputTokens: turn.usage.outputTokens ?? 0, cacheReadTokens: turn.usage.cacheReadTokens ?? 0, cacheWrite5mTokens: turn.usage.cacheWrite5mTokens ?? 0, cacheWrite1hTokens: turn.usage.cacheWrite1hTokens ?? 0 } : emptyUsage();
  costUsd = turn.costUsd;
  rounds = turn.rounds;

  const fail = async (message: string, retryable: boolean, severity: 'warning' | 'critical' = 'critical'): Promise<TurnOutcome> => {
    await store.updateTurn(turnId, { status: 'failed', error: message, finishedAt: new Date(), usage: usage as unknown as Record<string, number>, costUsd, rounds });
    await emit({ type: 'error', message: `Analyst request failed: ${message}`, retryable });
    await emit({ type: 'done', status: 'failed' });
    await noteAnthropicOutcome({ ok: false, error: message, severity, feature: 'analyst' });
    return outcome('failed', { error: message });
  };

  // The log: append this turn's user row on first start; resume from it otherwise.
  let rows = await store.listMessages(threadId);
  const alreadyStarted = rows.some((r) => r.turnId === turnId);
  if (!alreadyStarted) {
    if (!deps.userTurn) return fail('no user turn to run', false);
    if (rows.length === 0 && deps.starterRows?.length) {
      // A new thread opens with the snapshot (r1, r2) and the question inside the same user message (one row).
      await store.appendMessages(threadId, deps.starterRows);
      await emit({ type: 'tools', calls: deps.starterRows.flatMap((r) => ((r.display?.tools as Array<{ ref: string; name: string; label: string }> | undefined) ?? [])) });
    } else await store.appendMessages(threadId, [{ turnId, role: 'user', apiJson: JSON.stringify({ role: 'user', content: deps.userTurn } satisfies BetaMessageParam), display: { question: turn.question } }]);
    rows = await store.listMessages(threadId);
    await emit({ type: 'notice', text: deps.freshness.line, stale: deps.freshness.stale });
  }
  const { ledger } = ledgerFromLog(rows);
  let calls = ledgerFromLog(rows).calls;
  let repairs = countRepairs(turn.events);
  const toolDefs: BetaTool[] = deps.tools.map((t) => t.definition);
  const model = thread.model as AnalystModel;
  const effort = thread.effort as Effort;
  const answerMode = thread.answerMode as AnswerMode;

  // Oct 7 item 2a: a targeted repair in flight — the next request asks for the listed fields only and they are spliced into the rejected answer.
  let pendingRepair: { paths: string[]; rejected: Answer } | null = null;
  const request = () => {
    const { messages, carriesCompaction } = historyFromLog(rows);
    const input = { model, effort, system: [deps.contract, deps.brief.text] as [string, string], tools: toolDefs, messages, answerSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode, maxTokens: deps.maxTokens ?? 16_000 };
    return pendingRepair ? buildRepairRequest({ ...input, repairSchema: REPAIR_SCHEMA as unknown as Record<string, unknown> }, { carriesCompaction }) : buildTurnRequest(input, { carriesCompaction });
  };

  // Oct 7 item 6: time to the first verified section — read from the partial answer JSON as it streams. Wave 2
  // tune-up 3: EVERY section is verified and emitted (rendered) the moment it closes; each round's wall time and
  // time-to-first-token are measured.
  let firstSectionSeconds: number | null = null;
  let lastRoundTiming: { seconds: number; firstTokenSeconds: number | null } = { seconds: 0, firstTokenSeconds: null };
  const streamRound = async (): Promise<BetaMessage> => {
    const roundStartedAt = now();
    let firstTokenAt: number | null = null;
    const stream = deps.client.beta.messages.stream(request());
    let lastStatus = '';
    let buffer = '';
    let answerText = '';
    let answerBlock = false;
    let emittedSections = 0;
    for await (const ev of stream) {
      if (firstTokenAt === null && ev.type === 'content_block_delta') firstTokenAt = now();
      if (ev.type === 'content_block_start') answerBlock = ev.content_block.type === 'text' || (ev.content_block.type === 'tool_use' && ev.content_block.name === SUBMIT_ANSWER_TOOL);
      if (!pendingRepair && answerBlock && ev.type === 'content_block_delta' && (ev.delta.type === 'text_delta' || ev.delta.type === 'input_json_delta')) {
        answerText += ev.delta.type === 'text_delta' ? ev.delta.text : ev.delta.partial_json;
        const sections = completedSections(answerText);
        for (let i = emittedSections; i < sections.length; i++) {
          const section = sections[i];
          const probe: Answer = { kind: 'answer', headline: { text: '' }, sections: [{ key: section.key as Answer['sections'][number]['key'], body_md: section.body_md }], actions: [], findings: [], note_proposals: [], clarifying_question: '' };
          const v = verifyAnswer(probe, ledger, { staleBefore: deps.staleBefore, question: turn.question });
          const seconds = Math.round(((now() - startedAt) / 1000) * 10) / 10;
          if (firstSectionSeconds === null) firstSectionSeconds = seconds;
          await emit({ type: 'section', key: section.key, verified: v.ok, seconds, index: i, body_md: renderText(section.body_md, ledger, v.flagged.filter((f) => f.section === section.key)) });
          emittedSections = i + 1;
        }
      }
      if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') buffer += ev.delta.thinking;
      if (ev.type === 'content_block_stop') {
        const text = buffer.trim();
        buffer = '';
        if (text && text !== lastStatus) {
          lastStatus = text;
          await emit({ type: 'status', text: text.slice(0, 240) });
        }
      }
    }
    const message = await stream.finalMessage();
    lastRoundTiming = { seconds: Math.round(((now() - roundStartedAt) / 1000) * 10) / 10, firstTokenSeconds: firstTokenAt === null ? null : Math.round(((firstTokenAt - roundStartedAt) / 1000) * 10) / 10 };
    return message;
  };

  let lastInputTotal = 0;
  // The visible output of this run's responses (a resumed turn's earlier rounds are not re-measured: the split then says ≈).
  let visibleOutput = '';
  while (rounds < maxRounds) {
    const live = await store.getTurn(turnId);
    if (live?.stopRequested) {
      await store.updateTurn(turnId, { status: 'stopped', finishedAt: new Date(), usage: usage as unknown as Record<string, number>, costUsd, rounds });
      await emit({ type: 'stopped' });
      await emit({ type: 'done', status: 'stopped' });
      return outcome('stopped');
    }
    if (now() - startedAt > budgetMs) {
      await store.updateTurn(turnId, { usage: usage as unknown as Record<string, number>, costUsd, rounds });
      await emit({ type: 'continue' });
      return outcome('continue');
    }
    if (rounds > 0) {
      const nextRoundUsd = priceUsage(model, { input_tokens: 4_000, output_tokens: 2_000, cache_read_input_tokens: lastInputTotal });
      const pause = shouldPause({ spentUsd: costUsd, nextRoundUsd, allowedUsd: deps.allowedUsd });
      if (pause.pause) {
        await store.updateTurn(turnId, { status: 'needs_confirmation', usage: usage as unknown as Record<string, number>, costUsd, rounds });
        await emit({ type: 'needs_confirmation', reason: pause.reason!, spentUsd: costUsd });
        await emit({ type: 'done', status: 'needs_confirmation' });
        return outcome('needs_confirmation');
      }
    }

    let message: BetaMessage;
    try {
      try {
        message = await streamRound();
      } catch (err) {
        if (!isTransientError(err)) throw err;
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? RETRY_DELAY_MS));
        message = await streamRound(); // rebuilt from the log; nothing of the failed attempt was stored
      }
    } catch (err) {
      return fail(describeError(err), isTransientError(err), isTransientError(err) ? 'warning' : 'critical');
    }

    const u = message.usage as unknown as UsageLike;
    const t = usageTotals(u);
    usage = addUsage(usage, t);
    visibleOutput += message.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? JSON.stringify(b.input) : '')).join('');
    const roundUsd = priceUsage(model, u);
    costUsd += roundUsd;
    lastInputTotal = t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
    const dropped = inputTransformations(message);
    const cacheWriteTokens = t.cacheWrite5mTokens + t.cacheWrite1hTokens;
    await emit({ type: 'round', stopReason: message.stop_reason, inputTokens: t.inputTokens, cacheReadTokens: t.cacheReadTokens, cacheWriteTokens, cacheSharePct: cacheSharePct({ inputTokens: t.inputTokens, cacheReadTokens: t.cacheReadTokens, cacheWriteTokens }), outputTokens: t.outputTokens, droppedThinking: dropped.length, progressUpdates: progressUpdates(message).length, toolCalls: message.content.filter((b) => b.type === 'tool_use').length, costUsd: roundUsd, seconds: lastRoundTiming.seconds, firstTokenSeconds: lastRoundTiming.firstTokenSeconds });
    if (dropped.length) await emit({ type: 'status', text: `Earlier reasoning was dropped because the prefix changed (${dropped.map((d) => d.reason ?? d.type).join(', ')}) — expected after a deploy or a brief rebuild.` });

    if (message.stop_reason === 'refusal') return fail('Claude declined the request.', true, 'warning');
    if (message.stop_reason === 'max_tokens') return fail('the answer was cut off at max_tokens', true, 'warning');

    const toolUses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name !== SUBMIT_ANSWER_TOOL && b.name !== SUBMIT_REPAIR_TOOL);
    if (toolUses.length > 0) {
      const heartbeat = setInterval(() => void store.heartbeat(turnId), 15_000);
      let results: Array<{ id: string; ref: string; name: string; label: string; result: ToolResult }>;
      try {
        results = await Promise.all(
          toolUses.map(async (tu) => {
            calls += 1;
            const ref = `r${calls}`;
            const result = await runAnalystTool(tu.name, tu.input, { ref, freshness: deps.freshness, resolveRef: (r) => ledger.resolve(r), resolveInfo: (r) => ledger.info(r) }, deps.tools);
            return { id: tu.id, ref, name: tu.name, label: toolLabel(tu.name, tu.input), result };
          }),
        );
      } finally {
        clearInterval(heartbeat);
      }
      const fetchedAt = new Date().toISOString();
      for (const r of results) ledger.add(r.ref, r.result.data, fetchedAt, r.result.currency);
      const toolMessage: BetaMessageParam = {
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: JSON.stringify(r.result), ...(r.result.error && r.result.data === null ? { is_error: true } : {}) })),
      };
      await store.appendMessages(threadId, [
        { turnId, role: 'assistant', apiJson: JSON.stringify(assistantTurn(message)), display: { tools: results.map((r) => ({ ref: r.ref, name: r.name, label: r.label })) } },
        { turnId, role: 'tool_results', apiJson: JSON.stringify(toolMessage), display: { refs: results.map((r) => r.ref) } },
      ]);
      rows = await store.listMessages(threadId);
      rounds += 1;
      await store.updateTurn(turnId, { rounds, usage: usage as unknown as Record<string, number>, costUsd });
      await emit({ type: 'tools', calls: results.map((r) => ({ ref: r.ref, name: r.name, label: r.label })) });
      continue;
    }

    // A final answer: parse → structure → verify → (one repair) → accept, flagged if it must be.
    let parsed: { answer: Answer | null; problem: string | null };
    if (pendingRepair) {
      const r = repairFromMessage(message, answerMode);
      if (r.fields) {
        const sp = spliceFields(pendingRepair.rejected, r.fields, pendingRepair.paths);
        await emit({ type: 'status', text: `Repaired ${sp.applied.length} field${sp.applied.length === 1 ? '' : 's'}${sp.applied.length ? ` (${sp.applied.join(', ')})` : ''}${sp.ignored.length ? ` · ignored ${sp.ignored.length} unasked-for (${sp.ignored.join(', ')})` : ''}` });
        parsed = { answer: sp.answer, problem: null };
      } else {
        await emit({ type: 'status', text: `Repair returned nothing usable (${r.problem}) — the original fields stay, marked.` });
        parsed = { answer: pendingRepair.rejected, problem: null };
      }
      pendingRepair = null;
    } else parsed = answerFromMessage(message, answerMode);
    const { answer, problem } = parsed;
    // Wave 2 tune-up 1: the server owns the spend decisions — one per gate row, in gate order, written from the gate's
    // own refs; the model's spend actions survive only on a may_change row. The model's answer is verified and
    // repaired with its OWN indexing (a repair returns fields by path), skipping the spend actions the server will
    // replace — a model action past a hold never costs a repair; the decisions are applied after, then verified.
    const decideOpts = { stale: deps.freshness.stale, checkDate: new Date(now() + 7 * 86_400_000).toISOString().slice(0, 10) };
    const preview = answer ? applySpendDecisions(answer, ledger, decideOpts) : null;
    const skipSections = answer && preview ? new Set(answer.actions.map((a, i) => (a.kind === 'spend' && !preview.keptIndexes.includes(i) ? `actions[${i}]` : null)).filter((s): s is string => s !== null)) : null;
    const structural = answer ? checkStructure(answer) : problem;
    let verification = answer && !structural ? verifyAnswer(answer, ledger, { staleBefore: deps.staleBefore, question: turn.question, skipSections }) : null;
    // On stale data every decision is a server hold; the model's own spend proposals (if any) are replaced.
    const spendOnStale = answer && deps.freshness.stale ? answer.actions.filter((a) => a.kind === 'spend' && a.spend_change !== 'hold' && a.spend_change !== 'none').length : 0;
    const repairProblems: RepairProblem[] = [];
    if (structural) repairProblems.push({ kind: 'structure', section: 'answer', text: '', reason: structural });
    if (verification && !verification.ok) repairProblems.push(...verification.flagged.map((f) => ({ kind: f.kind, section: f.section, text: f.text, reason: f.reason })));
    const problems = repairProblems.map((p) => (p.kind === 'structure' ? p.reason : `${p.section}: "${p.text}" — ${p.reason}`));

    if (problems.length && repairs < 1) {
      repairs += 1;
      // Oct 7 item 2a: text-field problems get a TARGETED repair (only those fields come back and are spliced in);
      // a structure or evidence problem regenerates the whole answer. The rejected answer is the MODEL's (its own
      // spend actions): the decisions are re-applied to whatever comes back.
      const targeted = answer !== null && repairProblems.every((p) => TARGETED_KINDS.has(p.kind));
      const paths = targeted ? [...new Set(repairProblems.map((p) => p.section))] : [];
      if (targeted) pendingRepair = { paths, rejected: answer };
      await emit({ type: 'repair', problems: repairProblems, targeted, paths });
      await store.appendMessages(threadId, [
        { turnId, role: 'assistant', apiJson: JSON.stringify(assistantTurn(message)), display: { rejected: true, problems, targeted } },
        { turnId, role: 'user', apiJson: JSON.stringify({ role: 'user', content: targeted ? targetedRepairMessage(repairProblems) : repairMessage(problems) } satisfies BetaMessageParam), display: { repair: true, targeted, paths } },
      ]);
      rows = await store.listMessages(threadId);
      rounds += 1;
      await store.updateTurn(turnId, { rounds, usage: usage as unknown as Record<string, number>, costUsd });
      await emit({ type: 'status', text: 'Repairing the answer…' });
      continue;
    }
    if (!answer || structural) return fail(`The answer didn't have the required structure: ${structural ?? problem}`, true);

    // The decisions, applied to the accepted (repaired) model answer; the server-written holds are all tokens from the
    // gate's own refs, so this verification can only flag what the model wrote on a may_change row.
    const decided = applySpendDecisions(answer, ledger, decideOpts);
    for (const note of decided.notes) await emit({ type: 'status', text: note });
    const spendDecisions = decided.decisions;
    let accepted: Answer = decided.answer;
    verification = verifyAnswer(accepted, ledger, { staleBefore: deps.staleBefore, question: turn.question });
    // Still failing after the repair: show flagged numbers marked. On stale data the model's spend proposals were
    // replaced by server holds; the answer says so in its own words.
    let strippedSpendActions = 0;
    if (spendOnStale) {
      strippedSpendActions = spendOnStale;
      accepted = { ...accepted, sections: [...accepted.sections, { key: accepted.sections.some((s) => s.key === 'data_health') ? 'data_health' : accepted.sections[accepted.sections.length - 1]?.key ?? 'what_happened', body_md: `_${strippedSpendActions === 1 ? 'A spend recommendation was' : 'Spend recommendations were'} replaced by a hold: ${deps.freshness.line}. Re-run after the sync completes._` }] };
      verification = verifyAnswer(accepted, ledger, { staleBefore: deps.staleBefore, question: turn.question });
    }
    const flagged = verification?.flagged ?? [];
    // The owner reads the RENDERED answer: every ref token printed by the server from the ledger; flags marked in place.
    const rendered = renderAnswer(accepted, ledger, flagged, spendDecisions);
    await store.appendMessages(threadId, [{ turnId, role: 'assistant', apiJson: JSON.stringify(assistantTurn(message)), display: { answer: accepted, rendered, flagged, repaired: repairs > 0, strippedSpendActions, spendDecisions } }]);
    await store.updateTurn(turnId, { status: 'done', finishedAt: new Date(), usage: usage as unknown as Record<string, number>, costUsd, rounds });
    await store.updateThread(threadId, { lastTurnAt: new Date(), ...(thread.title ? {} : { title: turn.question.slice(0, 80) }) });
    await emit({ type: 'answer', answer: accepted, rendered, flagged, repaired: repairs > 0, repairs, strippedSpendActions, spendDecisions, firstSectionSeconds });
    // Item D: the cost split. The visible output is measured (count_tokens) when a counter is given, else ≈ chars ÷ 3.5.
    let answerTokens = Math.ceil(visibleOutput.length / 3.5);
    let approximate = true;
    if (deps.countTokens && visibleOutput.trim()) {
      try {
        answerTokens = await deps.countTokens(visibleOutput);
        approximate = false;
      } catch (err) {
        await emit({ type: 'status', text: `Answer token count unavailable (${describeError(err)}); the split uses characters.` });
      }
    }
    const split = splitUsage(model, usage, answerTokens, approximate);
    await store.updateTurn(turnId, { usage: { ...(usage as unknown as Record<string, number>), answerTokens: split.answerTokens, thinkingTokens: split.thinkingTokens, inputUsd: split.inputUsd, cacheReadUsd: split.cacheReadUsd, cacheWriteUsd: split.cacheWriteUsd, thinkingUsd: split.thinkingUsd, answerUsd: split.answerUsd } });
    await emit({ type: 'usage', usage, costUsd, model, rounds, estimated: false, split });
    await noteAnthropicOutcome({ ok: true });
    // Item 6: proposals become `proposed` notes for the owner to approve; never silently dropped, never auto-active.
    if (accepted.note_proposals.length > 0) {
      if (deps.onProposals) {
        try {
          const r = await deps.onProposals(accepted.note_proposals);
          await emit({ type: 'status', text: `${r.saved} note proposal${r.saved === 1 ? '' : 's'} saved for your approval (Setup → Analyst → Notes)${r.skipped ? ` · ${r.skipped} already known` : ''}.` });
        } catch (err) {
          await emit({ type: 'status', text: `Note proposals could not be saved (${describeError(err)}): ${accepted.note_proposals.join(' | ')}` });
        }
      } else await emit({ type: 'status', text: `${accepted.note_proposals.length} note proposal${accepted.note_proposals.length === 1 ? '' : 's'} (not saved — no handler): ${accepted.note_proposals.join(' | ')}` });
    }

    // Compaction after a completed turn past the token limit — a separate request, same prefix, no output format.
    let compacted = false;
    if (lastInputTotal > (deps.compactAboveTokens ?? 300_000)) {
      try {
        rows = await store.listMessages(threadId);
        const { messages } = historyFromLog(rows);
        const summary = await deps.client.beta.messages.create(buildCompactionRequest({ model, effort, system: [deps.contract, deps.brief.text], tools: toolDefs, messages }, COMPACTION_INSTRUCTIONS));
        costUsd += priceUsage(model, summary.usage as unknown as UsageLike);
        if (summary.stop_reason === 'compaction' && summary.content.some((b) => b.type === 'compaction')) {
          await store.appendMessages(threadId, [{ turnId, role: 'compaction', apiJson: JSON.stringify(assistantTurn(summary)), display: { compaction: true } }]);
          compacted = true;
          await emit({ type: 'status', text: 'Conversation compacted (the transcript is kept; the model continues from a summary).' });
        } else await emit({ type: 'status', text: `Compaction returned no summary (${summary.stop_reason}); continuing without it.` });
        await store.updateTurn(turnId, { costUsd });
      } catch (err) {
        await emit({ type: 'status', text: `Compaction failed (${describeError(err)}); continuing without it.` });
      }
    }
    await emit({ type: 'done', status: 'done' });
    return outcome('done', { answer: accepted, rendered, flagged, compacted, split, spendDecisions });
  }
  return fail(`no answer after ${maxRounds} rounds`, true);
}

/** Amendment 1: a running turn whose heartbeat is older than 5 minutes is failed with the reason, and an incident is opened. */
export const ORPHAN_AFTER_MS = 5 * 60_000;
export const ORPHAN_REASON = 'the function stopped mid-round and nothing resumed it';

export async function sweepOrphanTurns(store: AnalystStore, now: Date = new Date()): Promise<TurnRow[]> {
  const swept = await store.sweepOrphans(new Date(now.getTime() - ORPHAN_AFTER_MS), ORPHAN_REASON);
  for (const t of swept) await store.appendEvent(t.id, { type: 'error', message: `Analyst request failed: ${ORPHAN_REASON}`, retryable: true });
  return swept;
}

export function costLine(usage: UsageTotals, costUsd: number): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  const inTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  return `${k(inTotal)} in${usage.cacheReadTokens ? ` (${k(usage.cacheReadTokens)} cached)` : ''} · ${k(usage.outputTokens)} out · ${formatUsd(costUsd)}`;
}
