/**
 * Live probe of every API assumption the Analyst runtime is built on (plan item 1), on the
 * PRODUCTION wiring. `npm run smoke:analyst -- --probe`. Real requests on both models; about
 * $1 USD (two short turns per model with the real brief in the prompt).
 *
 * Why it changed (2026-09-30): the first probe passed with a SAMPLE tool and a sample answer
 * schema, so it never sent the 15 production tools — and `npm run smoke:analyst` then failed on
 * its first request with `tools.1.custom: Invalid schema: Enum value 'today' does not match
 * declared type '['string','null']'`. The probe now sends exactly what a user's question sends:
 * the contract, the current brief, ANALYST_TOOLS and ANSWER_SCHEMA as `output_config.format`,
 * through the same loop (`runAnalystTurn`) on the in-memory store. Its first line is the free
 * count_tokens schema check.
 *
 *   PASS <assumption> · <model> · <in>/<out> tokens · $<cost> USD · <detail>
 *   FAIL <assumption> · <model> · Anthropic <status> · <type>: <message>
 *
 * SKIP means nothing was exercised (no key, no brief) and is NOT verification. Nothing is written
 * to the database.
 */

import { ANALYST_MODEL_OPTIONS, type AnalystModel, type AnswerMode } from './config';
import { loopClient, makeAnalystClient } from './api';
import { formatUsd, type UsageTotals } from './cost';
import { ANALYST_TOOLS } from './tools';
import { ANALYST_CONTRACT, composeUserTurn } from './prompts';
import { runAnalystTurn, type AnalystEvent } from './run';
import { MemoryAnalystStore } from './store';
import { checkAnalystSchemasLive } from './schemaCheck';
import { currentBrief } from './briefService';
import { getTimezone } from '../settings';
import { todayInTimezone } from '../day';

export interface ProbeLine {
  status: 'PASS' | 'FAIL' | 'SKIP';
  assumption: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  detail: string;
}

export function formatProbeLine(l: ProbeLine): string {
  const tokens = l.inputTokens || l.outputTokens ? ` · ${l.inputTokens}/${l.outputTokens} tokens · ${formatUsd(l.usd)}` : '';
  return `${l.status} ${l.assumption}${l.model ? ` · ${l.model}` : ''}${tokens}${l.detail ? ` · ${l.detail}` : ''}`;
}

const PROBE_QUESTION =
  'Wiring probe. Make exactly THREE tool calls, one per turn, in this order: 1) get_notes; 2) get_data_health for the preset last_week; 3) get_metric with key "enrollments" for the preset last_week, mode period. Then answer with kind "answer" and ONE section "what_happened" that names the three tools you called and says the probe is complete — write NO numbers anywhere in the prose, headline "Probe complete." with ref "".';
const FOLLOW_UP = 'Follow-up: without calling any tool, answer with kind "answer", one section "what_happened", saying in one sentence which three tools the previous turn called. No numbers. Headline "Follow-up complete." with ref "".';

interface Round {
  stopReason: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  droppedThinking: number;
  progressUpdates: number;
  toolCalls: number;
}

export async function runAnalystProbe(opts: { key: string | null; models?: AnalystModel[]; answerMode?: AnswerMode }): Promise<{ lines: ProbeLine[]; ok: boolean; answerMode: Record<string, AnswerMode | 'neither'> }> {
  const lines: ProbeLine[] = [];
  const answerMode: Record<string, AnswerMode | 'neither'> = {};
  const skip = (detail: string) => {
    lines.push({ status: 'SKIP', assumption: 'every assumption', model: null, inputTokens: 0, outputTokens: 0, usd: 0, detail });
    return { lines, ok: false, answerMode };
  };
  if (!opts.key) return skip('no Anthropic API key stored (Setup → Anthropic) — nothing was exercised');
  const brief = await currentBrief();
  if (!brief) return skip("the business brief hasn't been built yet — run `npm run analyst:brief` (the probe sends the real brief)");
  const client = loopClient(makeAnalystClient(opts.key));
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const mode: AnswerMode = opts.answerMode ?? 'format';

  for (const model of opts.models ?? ANALYST_MODEL_OPTIONS) {
    // 1. The free schema check on the exact production prompt.
    const [schema] = await checkAnalystSchemasLive({ key: opts.key, brief: brief.text, models: [model] });
    lines.push({ status: schema.ok ? 'PASS' : 'FAIL', assumption: 'production schemas accepted by count_tokens (15 tools + the answer schema)', model, inputTokens: schema.inputTokens ?? 0, outputTokens: 0, usd: 0, detail: schema.message });

    const store = new MemoryAnalystStore();
    const thread = await store.createThread({ model, effort: 'low', answerMode: mode, briefHash: brief.hash });
    const rounds: Round[] = [];
    let statuses = 0;
    let usage: UsageTotals | null = null;
    let usd = 0;
    const events: AnalystEvent[] = [];
    const onEvent = (e: AnalystEvent) => {
      events.push(e);
      if (e.type === 'round') rounds.push(e);
      if (e.type === 'status' && !e.text.startsWith('Repairing') && !e.text.startsWith('Earlier reasoning') && !e.text.startsWith('Conversation compacted') && !e.text.startsWith('Compaction')) statuses += 1;
      if (e.type === 'usage') {
        usage = e.usage;
        usd += e.costUsd;
      }
    };
    const deps = { store, client, contract: ANALYST_CONTRACT, brief: { text: brief.text, hash: brief.hash }, tools: ANALYST_TOOLS, freshness: { stale: false, line: 'probe — freshness not evaluated', sources: [] }, allowedUsd: 3, maxRounds: 8, maxTokens: 4000, compactAboveTokens: 0, onEvent };
    const line = (status: ProbeLine['status'], assumption: string, detail: string): ProbeLine => {
      const u = usage as UsageTotals | null;
      return { status, assumption, model, inputTokens: u ? u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens : 0, outputTokens: u?.outputTokens ?? 0, usd, detail };
    };

    // 2–7: the real loop, turn 1 (three sequential tools → a structured answer, streamed) with compaction forced after it.
    const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: 'probe-1', question: PROBE_QUESTION, kind: 'ask', pageContext: null });
    const out = await runAnalystTurn(thread.id, turn.id, { ...deps, userTurn: composeUserTurn({ question: PROBE_QUESTION, kind: 'answer', healthLine: 'probe', today, timezone }) });
    const firstToolCalls = rounds[0]?.toolCalls ?? 0;
    lines.push(line(firstToolCalls > 0 ? 'PASS' : 'FAIL', 'tool_choice auto + strict production tools → the model calls a tool', firstToolCalls > 0 ? `round 1 called ${firstToolCalls} tool(s): ${events.filter((e) => e.type === 'tools').flatMap((e) => (e.type === 'tools' ? e.calls.map((c) => c.name) : [])).slice(0, 3).join(', ')}` : `round 1 stop_reason=${rounds[0]?.stopReason ?? 'none'} · ${out.error ?? out.status}`));
    const toolRounds = rounds.filter((r) => r.toolCalls > 0).length;
    const toolCalls = rounds.reduce((a, r) => a + r.toolCalls, 0);
    const answered = out.status === 'done' && out.answer !== null;
    answerMode[model] = answered ? mode : 'neither';
    lines.push(
      line(
        answered && toolCalls >= 3 ? 'PASS' : 'FAIL',
        `${mode === 'format' ? 'output_config.format' : 'submit_answer tool'} after ≥ 3 production tool calls, streamed → schema-valid answer`,
        answered ? `${toolRounds} tool round(s) · ${toolCalls} tool call(s) · kind ${out.answer!.kind} · sections ${out.answer!.sections.map((s) => s.key).join(',')} · headline "${out.answer!.headline.text}"${out.flagged.length ? ` · ${out.flagged.length} flagged number(s)` : ''}${toolCalls < 3 ? ' · fewer than 3 tool calls (the model batched or skipped)' : ''}` : `status ${out.status} · ${out.error ?? 'no answer'}`,
      ),
    );
    // Turn 2: the compaction block first in messages, then a follow-up — proves the block is accepted and the cache still reads.
    let secondOk = false;
    let secondDetail = 'turn 1 did not complete';
    if (answered) {
      const compacted = (await store.listMessages(thread.id)).some((m) => m.role === 'compaction');
      const { turn: t2 } = await store.createTurn({ threadId: thread.id, clientTurnId: 'probe-2', question: FOLLOW_UP, kind: 'ask', pageContext: null });
      const out2 = await runAnalystTurn(thread.id, t2.id, { ...deps, compactAboveTokens: Number.MAX_SAFE_INTEGER, userTurn: composeUserTurn({ question: FOLLOW_UP, kind: 'answer', healthLine: 'probe', today, timezone }) });
      secondOk = out2.status === 'done' && out2.answer !== null;
      secondDetail = compacted ? (secondOk ? `compaction block returned after turn 1 · turn 2 carried it first and answered "${out2.answer!.headline.text}"` : `compaction block returned · turn 2 ${out2.status}: ${out2.error ?? ''}`) : `no compaction block was stored after turn 1 (${events.filter((e) => e.type === 'status').map((e) => (e.type === 'status' ? e.text : '')).filter((t) => t.startsWith('Compaction')).join('; ') || 'no compaction status'})`;
      lines.push(line(compacted && secondOk ? 'PASS' : 'FAIL', 'on-demand compaction returns a block; the next turn accepts it', secondDetail));
    } else {
      lines.push(line('FAIL', 'on-demand compaction returns a block; the next turn accepts it', secondDetail));
    }
    // 4: cache reads on every request after the first.
    const later = rounds.slice(1);
    const reads = later.map((r) => r.cacheReadTokens);
    lines.push(line(later.length > 0 && reads.every((n) => n > 0) ? 'PASS' : 'FAIL', 'cache_read_input_tokens > 0 on every request after the first', `request 1 wrote ${rounds[0]?.cacheWriteTokens ?? 0} · later requests read ${reads.join(', ') || 'none — fewer than two requests'}`));
    // 5: display updates accepted (zero-or-more; Opus 5.5 rarely writes them).
    const updates = rounds.reduce((a, r) => a + r.progressUpdates, 0);
    lines.push(line(rounds.length > 0 ? 'PASS' : 'FAIL', 'thinking.display "updates" accepted', `${updates} progress update(s) as text across ${rounds.length} request(s)${updates === 0 ? ' (zero is allowed; the model may skip any gap)' : ''} · ${statuses} status line(s) shown`));
    // 6: drop_block set; nothing dropped because the history was replayed byte for byte.
    const dropped = rounds.reduce((a, r) => a + r.droppedThinking, 0);
    lines.push(line(rounds.length > 1 && dropped === 0 ? 'PASS' : 'FAIL', 'drop_block accepted; input_transformations empty on an untouched history', `${Math.max(0, rounds.length - 1)} replay(s), ${dropped} dropped thinking block(s)`));
  }
  return { lines, ok: lines.length > 0 && lines.every((l) => l.status === 'PASS'), answerMode };
}
