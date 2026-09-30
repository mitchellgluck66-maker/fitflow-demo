/**
 * The Analyst's wire contract with the Anthropic API — ONE pure request builder
 * that every Analyst call (probe, turns, compaction, Verify, smoke) goes through,
 * so the contract test in tests/analyst-wire.test.ts checks the shape the API
 * actually receives. Verified against the docs on 2026-09-30 (plan → "API facts"):
 *
 *   - thinking is adaptive only; `effort` is set explicitly and fixed per thread;
 *   - `tool_choice` is `auto` (a forced choice is a 400 on both models);
 *   - thinking blocks are bound to the prefix; `drop_block` degrades a changed
 *     prefix instead of failing, and the response reports `input_transformations`;
 *   - `thinking.display: "updates"` returns progress updates as text;
 *   - prompt caching: tools → system → messages; ≤ 4 breakpoints; 5-minute TTL;
 *   - structured output (`output_config.format`) combines with strict tools, but
 *     is rejected on a compaction request, as is a forced tool_choice.
 *
 * Nothing here talks to the network except `makeAnalystClient`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ANALYST_BETAS, type AnalystModel, type AnswerMode, type Effort } from './config';

export type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

/** The strict tool the answer moves to when the probe shows `output_config.format` does not combine with tools. */
export const SUBMIT_ANSWER_TOOL = 'submit_answer';

export interface AnalystRequestInput {
  model: AnalystModel;
  effort: Effort;
  /** Frozen for the life of a thread: [contract, brief]. Each gets a cache breakpoint. */
  system: [contract: string, brief: string];
  /** Frozen, name-sorted, strict, read-only. */
  tools: BetaTool[];
  messages: BetaMessageParam[];
  /** The one answer schema (JSON Schema, strict-compatible). */
  answerSchema: Record<string, unknown>;
  answerMode: AnswerMode;
  maxTokens: number;
}

/** The betas every turn request carries, in a fixed order (order is part of the cache key). */
export const TURN_BETAS = [ANALYST_BETAS.displayUpdates, ANALYST_BETAS.bindingControls] as const;

/**
 * A turn request. The output schema is the last thing to change between turns
 * only if `answerMode` changes, which never happens inside a thread.
 */
export function buildTurnRequest(input: AnalystRequestInput, opts: { carriesCompaction?: boolean } = {}): BetaParams {
  const sortedTools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  if (sortedTools.some((t, i) => i > 0 && t.name === sortedTools[i - 1].name)) throw new Error('duplicate tool name');
  const tools: BetaTool[] =
    input.answerMode === 'submit_answer'
      ? [...sortedTools, { name: SUBMIT_ANSWER_TOOL, description: 'Submit the final answer. Call this exactly once, when every number you will show has a ref.', input_schema: input.answerSchema as BetaTool['input_schema'], strict: true }].sort((a, b) => a.name.localeCompare(b.name))
      : sortedTools;
  const betas: string[] = [...TURN_BETAS, ...(opts.carriesCompaction ? [ANALYST_BETAS.compaction] : [])];
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    betas,
    system: [
      { type: 'text', text: input.system[0], cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.system[1], cache_control: { type: 'ephemeral' } },
    ],
    tools,
    tool_choice: { type: 'auto' },
    thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: {
      effort: input.effort,
      ...(input.answerMode === 'format' ? { format: { type: 'json_schema', schema: input.answerSchema } } : {}),
    },
    messages: input.messages,
  };
}

/**
 * The on-demand compaction request: same model, system and tools (so the kept turns' thinking stays
 * valid), the summarize instruction, and NONE of the fields the API rejects on it (output format,
 * forced tool_choice, stop_sequences). The caller must have answered every tool call first.
 */
export function buildCompactionRequest(input: Omit<AnalystRequestInput, 'answerSchema' | 'answerMode' | 'maxTokens'>, instructions: string): BetaParams {
  const tools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  return {
    model: input.model,
    max_tokens: 8192,
    betas: [...TURN_BETAS, ANALYST_BETAS.compaction],
    system: [
      { type: 'text', text: input.system[0], cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.system[1], cache_control: { type: 'ephemeral' } },
    ],
    tools,
    thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort: input.effort },
    messages: input.messages,
    compaction: { type: 'summarize', instructions },
  };
}

/** The token-count request for the same prompt (the endpoint ignores `compaction`; `output_config` is not accepted). */
export function buildCountRequest(input: Pick<AnalystRequestInput, 'model' | 'system' | 'tools' | 'messages'>): Anthropic.Beta.Messages.MessageCountTokensParams {
  return {
    model: input.model,
    betas: [...TURN_BETAS],
    system: [
      { type: 'text', text: input.system[0], cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.system[1], cache_control: { type: 'ephemeral' } },
    ],
    tools: [...input.tools].sort((a, b) => a.name.localeCompare(b.name)),
    thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    messages: input.messages,
  };
}

/**
 * The Analyst's own client: no SDK retries (the loop retries a transient failure once, from the
 * log), a long timeout (a Fable report can stream for minutes), explicit fetch so tests can stub it.
 */
export function makeAnalystClient(key: string): Anthropic {
  return new Anthropic({ apiKey: key, maxRetries: 0, fetch: globalThis.fetch, timeout: 600_000 });
}

/** The slice of the SDK the loop uses (lib/analyst/run.ts#AnalystClient), so tests can hand it a fake stream. */
export function loopClient(client: Anthropic) {
  return {
    beta: {
      messages: {
        stream: (params: BetaParams) => client.beta.messages.stream(params),
        create: (params: BetaParams) => client.beta.messages.create(params),
      },
    },
  };
}

/** Non-empty thinking text under `display: "updates"` is a progress update; everything else is hidden reasoning. */
export function progressUpdates(message: Pick<BetaMessage, 'content'>): string[] {
  return message.content.filter((b): b is Anthropic.Beta.Messages.BetaThinkingBlock => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0).map((b) => b.thinking.trim());
}

/** The response's `input_transformations` (only present with the binding-controls beta). Empty = the history replayed untouched. */
export function inputTransformations(message: BetaMessage): Array<{ type: string; reason?: string }> {
  const raw = (message as unknown as { input_transformations?: Array<{ type: string; reason?: string }> | null }).input_transformations;
  return Array.isArray(raw) ? raw : [];
}

/**
 * The response message as the next request's assistant turn, byte-for-byte: every block as returned
 * (thinking blocks included — they are bound to this prefix and must be echoed unchanged).
 */
export function assistantTurn(message: BetaMessage): BetaMessageParam {
  return { role: 'assistant', content: message.content as unknown as BetaMessageParam['content'] };
}
