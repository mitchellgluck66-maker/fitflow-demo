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
 *   3. A number is shown only with a ref (lib/analyst/verify.ts); one repair
 *      turn, then flagged numbers are shown marked, never silently.
 *   4. Stale data is decided by the server: the notice is the first event; a
 *      spend action on stale data is repaired, then stripped with a reason.
 *   5. The run is not the connection: progress is stored on the turn; Stop is
 *      explicit; past the time budget the turn persists and emits `continue`.
 *   6. Cost: estimated and capped before spending, re-checked between rounds.
 */

import Anthropic from '@anthropic-ai/sdk';
import { assistantTurn, buildCompactionRequest, buildTurnRequest, inputTransformations, SUBMIT_ANSWER_TOOL, type BetaMessage, type BetaMessageParam, type BetaTool } from './api';
import { isTransientError, describeError, RETRY_DELAY_MS } from '../anthropic/client';
import { noteAnthropicOutcome } from '../anthropic/incident';
import { ANSWER_SCHEMA, AnswerSchema, checkStructure, type Answer } from './schema';
import { Ledger } from './ledger';
import { repairMessage, verifyAnswer, type Flag } from './verify';
import { formatUsd, priceUsage, shouldPause, usageTotals, type UsageLike, type UsageTotals } from './cost';
import { runAnalystTool, type AnalystTool, type Freshness, type ToolResult } from './tools';
import { COMPACTION_INSTRUCTIONS } from './prompts';
import type { AnalystStore, MessageRow, TurnRow } from './store';
import type { AnalystModel, AnswerMode, Effort } from './config';

export type AnalystEvent =
  | { type: 'notice'; text: string; stale: boolean }
  | { type: 'status'; text: string }
  | { type: 'tools'; calls: Array<{ ref: string; name: string; label: string }> }
  | { type: 'answer'; answer: Answer; flagged: Flag[]; repaired: boolean; strippedSpendActions: number }
  | { type: 'usage'; usage: UsageTotals; costUsd: number; model: string; rounds: number; estimated: boolean }
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
  onEvent?: (e: AnalystEvent) => void;
}

export interface TurnOutcome {
  status: 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'continue';
  answer: Answer | null;
  flagged: Flag[];
  usage: UsageTotals;
  costUsd: number;
  rounds: number;
  error: string | null;
  compacted: boolean;
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
    const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; content?: string }> };
    for (const b of msg.content ?? []) {
      if (b.type !== 'tool_result' || typeof b.content !== 'string') continue;
      calls += 1;
      try {
        const res = JSON.parse(b.content) as ToolResult;
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
  calculate: (i) => `Calculating (${String(i.op ?? 'arithmetic')})…`,
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

  const outcome = (status: TurnOutcome['status'], extra: Partial<TurnOutcome> = {}): TurnOutcome => ({ status, answer: null, flagged: [], usage, costUsd, rounds, error: null, compacted: false, ...extra });
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
    await store.appendMessages(threadId, [{ turnId, role: 'user', apiJson: JSON.stringify({ role: 'user', content: deps.userTurn } satisfies BetaMessageParam), display: { question: turn.question } }]);
    rows = await store.listMessages(threadId);
    await emit({ type: 'notice', text: deps.freshness.line, stale: deps.freshness.stale });
  }
  const { ledger } = ledgerFromLog(rows);
  let calls = ledgerFromLog(rows).calls;
  let repairs = turn.events.filter((e) => e.type === 'status' && e.text === 'Repairing the answer…').length;
  const toolDefs: BetaTool[] = deps.tools.map((t) => t.definition);
  const model = thread.model as AnalystModel;
  const effort = thread.effort as Effort;
  const answerMode = thread.answerMode as AnswerMode;

  const request = () => {
    const { messages, carriesCompaction } = historyFromLog(rows);
    return buildTurnRequest({ model, effort, system: [deps.contract, deps.brief.text], tools: toolDefs, messages, answerSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode, maxTokens: deps.maxTokens ?? 16_000 }, { carriesCompaction });
  };

  const streamRound = async (): Promise<BetaMessage> => {
    const stream = deps.client.beta.messages.stream(request());
    let lastStatus = '';
    let buffer = '';
    for await (const ev of stream) {
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
    return stream.finalMessage();
  };

  let lastInputTotal = 0;
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
    costUsd += priceUsage(model, u);
    lastInputTotal = t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
    const dropped = inputTransformations(message);
    if (dropped.length) await emit({ type: 'status', text: `Earlier reasoning was dropped because the prefix changed (${dropped.map((d) => d.reason ?? d.type).join(', ')}) — expected after a deploy or a brief rebuild.` });

    if (message.stop_reason === 'refusal') return fail('Claude declined the request.', true, 'warning');
    if (message.stop_reason === 'max_tokens') return fail('the answer was cut off at max_tokens', true, 'warning');

    const toolUses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name !== SUBMIT_ANSWER_TOOL);
    if (toolUses.length > 0) {
      const heartbeat = setInterval(() => void store.heartbeat(turnId), 15_000);
      let results: Array<{ id: string; ref: string; name: string; label: string; result: ToolResult }>;
      try {
        results = await Promise.all(
          toolUses.map(async (tu) => {
            calls += 1;
            const ref = `r${calls}`;
            const result = await runAnalystTool(tu.name, tu.input, { ref, freshness: deps.freshness, resolveRef: (r) => ledger.resolve(r) }, deps.tools);
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
    const { answer, problem } = answerFromMessage(message, answerMode);
    const structural = answer ? checkStructure(answer) : problem;
    let verification = answer && !structural ? verifyAnswer(answer, ledger, { staleBefore: deps.staleBefore }) : null;
    const spendOnStale = answer && deps.freshness.stale ? answer.actions.filter((a) => a.kind === 'spend').length : 0;
    const problems: string[] = [];
    if (structural) problems.push(structural);
    if (verification && !verification.ok) problems.push(...verification.flagged.map((f) => `${f.section}: "${f.text}" — ${f.reason}`));
    if (spendOnStale) problems.push(`remove the ${spendOnStale} spend action(s): a data source is stale (${deps.freshness.line}); say what you would recommend once the sync completes instead`);

    if (problems.length && repairs < 1) {
      repairs += 1;
      await store.appendMessages(threadId, [
        { turnId, role: 'assistant', apiJson: JSON.stringify(assistantTurn(message)), display: { rejected: true, problems } },
        { turnId, role: 'user', apiJson: JSON.stringify({ role: 'user', content: repairMessage(problems) } satisfies BetaMessageParam), display: { repair: true } },
      ]);
      rows = await store.listMessages(threadId);
      rounds += 1;
      await store.updateTurn(turnId, { rounds, usage: usage as unknown as Record<string, number>, costUsd });
      await emit({ type: 'status', text: 'Repairing the answer…' });
      continue;
    }
    if (!answer || structural) return fail(`The answer didn't have the required structure: ${structural ?? problem}`, true);

    // Still failing after the repair: show flagged numbers marked, strip spend actions on stale data with a reason.
    let strippedSpendActions = 0;
    let accepted: Answer = answer;
    if (spendOnStale) {
      strippedSpendActions = spendOnStale;
      accepted = { ...answer, actions: answer.actions.filter((a) => a.kind !== 'spend') };
      accepted.sections = [...accepted.sections, { key: accepted.sections.some((s) => s.key === 'data_health') ? 'data_health' : accepted.sections[accepted.sections.length - 1]?.key ?? 'what_happened', body_md: `_${strippedSpendActions} spend recommendation${strippedSpendActions === 1 ? '' : 's'} removed: ${deps.freshness.line}. Re-run after the sync completes._`, numbers: [] }];
      verification = verifyAnswer(accepted, ledger, { staleBefore: deps.staleBefore });
    }
    const flagged = verification?.flagged ?? [];
    await store.appendMessages(threadId, [{ turnId, role: 'assistant', apiJson: JSON.stringify(assistantTurn(message)), display: { answer: accepted, flagged, repaired: repairs > 0, strippedSpendActions } }]);
    await store.updateTurn(turnId, { status: 'done', finishedAt: new Date(), usage: usage as unknown as Record<string, number>, costUsd, rounds });
    await store.updateThread(threadId, { lastTurnAt: new Date(), ...(thread.title ? {} : { title: turn.question.slice(0, 80) }) });
    await emit({ type: 'answer', answer: accepted, flagged, repaired: repairs > 0, strippedSpendActions });
    await emit({ type: 'usage', usage, costUsd, model, rounds, estimated: false });
    await noteAnthropicOutcome({ ok: true });

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
    return outcome('done', { answer: accepted, flagged, compacted });
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
