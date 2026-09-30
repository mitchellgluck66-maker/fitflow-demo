/**
 * Setup → Analyst "Verify" (plan item 8, Definition of done §4): the SAME call
 * path the feature uses — a real two-round streamed tool turn on the chosen
 * model, run on the in-memory store so nothing is written. "Connected" means
 * the model called a tool, the answer came back structured and verified.
 */

import { getAnalystConfig, type AnalystModel } from './config';
import { currentBrief } from './briefService';
import { ANALYST_CONTRACT, composeUserTurn } from './prompts';
import { ANALYST_TOOLS } from './tools';
import { runAnalystTurn, costLine, type AnalystClient, type AnalystEvent } from './run';
import { MemoryAnalystStore } from './store';
import { loopClient, makeAnalystClient } from './api';
import { currentFreshness, newestMarkerAt } from './service';
import { getTimezone } from '../settings';
import { todayInTimezone } from '../dates';

export interface VerifyResult {
  ok: boolean;
  message: string;
  model: string;
  rounds: number;
  costUsd: number;
  toolsCalled: string[];
  answerMode: string;
}

export const VERIFY_QUESTION = 'Connection check: call get_notes exactly once, then answer with kind "answer", one section "what_happened" saying in one sentence that the connection works, no numbers anywhere, headline "Connected.".';

export async function verifyAnalystConnection(opts: { model?: AnalystModel; onEvent?: (e: AnalystEvent) => void; client?: AnalystClient } = {}): Promise<VerifyResult> {
  const config = await getAnalystConfig();
  const model = opts.model ?? config.modelDefault;
  if (!config.configured || !config.key) return { ok: false, message: 'Verification failed: no Anthropic API key stored (Setup → Anthropic)', model, rounds: 0, costUsd: 0, toolsCalled: [], answerMode: config.answerMode };
  const brief = await currentBrief();
  if (!brief) return { ok: false, message: "Verification failed: the business brief hasn't been built yet · Build now", model, rounds: 0, costUsd: 0, toolsCalled: [], answerMode: config.answerMode };
  const store = new MemoryAnalystStore();
  const thread = await store.createThread({ model, effort: 'low', answerMode: config.answerMode, briefHash: brief.hash });
  const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'verify', question: VERIFY_QUESTION, kind: 'ask', pageContext: null });
  const timezone = await getTimezone();
  const toolsCalled: string[] = [];
  const out = await runAnalystTurn(thread.id, turn.id, {
    store,
    client: opts.client ?? loopClient(makeAnalystClient(config.key)),
    contract: ANALYST_CONTRACT,
    brief: { text: brief.text, hash: brief.hash },
    tools: ANALYST_TOOLS,
    freshness: await currentFreshness(),
    staleBefore: await newestMarkerAt(),
    userTurn: composeUserTurn({ question: VERIFY_QUESTION, kind: 'answer', healthLine: 'connection check', today: todayInTimezone(timezone), timezone }),
    allowedUsd: 1,
    maxRounds: 4,
    maxTokens: 4000,
    onEvent: (e) => {
      if (e.type === 'tools') toolsCalled.push(...e.calls.map((c) => c.name));
      opts.onEvent?.(e);
    },
  });
  if (out.status !== 'done' || !out.answer) return { ok: false, message: `Verification failed: ${out.error ?? out.status}`, model, rounds: out.rounds, costUsd: out.costUsd, toolsCalled, answerMode: config.answerMode };
  if (toolsCalled.length === 0) return { ok: false, message: 'Verification failed: the model answered without calling a tool (tool_choice auto did not produce a call)', model, rounds: out.rounds, costUsd: out.costUsd, toolsCalled, answerMode: config.answerMode };
  if (out.flagged.length) return { ok: false, message: `Verification failed: the answer had ${out.flagged.length} unverified number(s): ${out.flagged.map((f) => f.reason).join('; ')}`, model, rounds: out.rounds, costUsd: out.costUsd, toolsCalled, answerMode: config.answerMode };
  return { ok: true, message: `Connected · verified with a streamed tool call · ${model} · ${toolsCalled.join(', ')} · ${costLine(out.usage, out.costUsd)}`, model, rounds: out.rounds, costUsd: out.costUsd, toolsCalled, answerMode: config.answerMode };
}
