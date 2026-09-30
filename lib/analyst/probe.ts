/**
 * Live probe of every API assumption the Analyst runtime is built on
 * (plan item 1). `npm run smoke:analyst -- --probe`. Real requests, small,
 * on both models; about $0.30 USD. Prints one line per assumption:
 *
 *   PASS <assumption> · <model> · <in>/<out> tokens · $<cost> USD · <detail>
 *   FAIL <assumption> · <model> · Anthropic <status> · <type>: <message>
 *
 * SKIP means nothing was exercised (no key) and is NOT verification.
 * Nothing here writes to the database.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { describeError } from '../anthropic/client';
import { ANALYST_MODEL_OPTIONS, type AnalystModel, type AnswerMode } from './config';
import { assistantTurn, buildCompactionRequest, buildCountRequest, buildTurnRequest, inputTransformations, makeAnalystClient, progressUpdates, SUBMIT_ANSWER_TOOL, type BetaMessage, type BetaMessageParam, type BetaTool } from './api';
import { formatUsd, priceUsage, usageTotals, type UsageLike } from './cost';

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

// ---------------------------------------------------------------------------
// Fixture: a small, deterministic "business" the probe can be checked against.
// The prompt must clear the 512-token cache minimum on its own (the checks read
// cache_read_input_tokens from round 2), so the contract is written out in full.
// ---------------------------------------------------------------------------

const PROBE_METRICS: Record<string, { value: number; unit: string; next: string | null }> = {
  applied: { value: 52, unit: 'people', next: 'enrollments' },
  enrollments: { value: 8, unit: 'people', next: 'consults_booked' },
  consults_booked: { value: 7, unit: 'people', next: null },
};

const PROBE_CONTRACT = `You are the FitFlow Analyst probe. This is a wiring check, not an analysis: follow the procedure exactly.

Procedure:
1. Call get_metric with name "applied".
2. Read the result. If its "next" field names another metric, call get_metric with that name. Make exactly ONE get_metric call per turn; never call two at once, and never guess a value.
3. When "next" is null, stop calling tools and give the final answer.

The final answer is JSON with three fields: "headline" (one short sentence), "total" (the integer sum of every value you fetched) and "refs" (every "ref" string the tool returned, in the order you fetched them, nothing else).

Rules that mirror the real Analyst's contract, stated here so the prompt is realistic in size and shape:
- A number may be shown only when a tool result contains it; the ref of that tool result must be cited.
- Never invent a metric, a person, a date or a currency. The business reports in CAD. Every amount carries its currency code.
- Applied means an opportunity created in the followed GoHighLevel pipeline in the period, dated by the opportunity; the definition is under review and the dashboard says so.
- Enrollments are entries into the Enrolled stage in the period. Consults booked are entries into the consult-booked stage.
- Paid CAC is spend divided by enrollments whose contact is paid-attributed; Blended CAC is spend divided by all enrollments. ROAS is paid-attributed initial cash divided by spend.
- Weeks run Sunday to Saturday in the business timezone (America/Edmonton). Never use UTC day boundaries.
- Stage history before 2026-09-01 is incomplete, so consults, roadmaps and every stage-to-stage conversion for earlier weeks are maturing data and must be flagged; enrollments, cash, spend, CAC and ROAS do not depend on that history.
- Failed payments count once per invoice. Refunds inherit the parent charge's customer. Fully refunded charges net to zero.
- Sample data is labelled origin=demo and is never presented as real.
- If a tool errors, say so and stop; do not retry with invented input.
- Do not average ratios; recompute from totals.
- Do not recommend spend changes while any source is stale.
- Keep the headline under twelve words.`;

const PROBE_BRIEF = `Business brief (probe fixture — fixed text, not live data).

The Fit Physician is a fitness coaching business that sells a 12-week coaching program to physicians. Leads apply through a form on the website, book a 15-minute consult, then a roadmap call, then enroll. The owner watches five numbers every week: initial cash collected, enrollments, Paid CAC, Blended CAC and ROAS, and three more on the second row: LTV:CAC, consults booked and cost per roadmap booked.

Recent weeks, in the probe fixture: week of Sep 6–12: 61 applied, 9 consults booked, 6 roadmaps booked, 5 enrolled, $3,120.44 CAD spend. Week of Sep 13–19: 58 applied, 11 consults booked, 8 roadmaps booked, 7 enrolled, $3,455.10 CAD spend. Week of Sep 20–26: 52 applied, 7 consults booked, 9 roadmaps booked, 8 enrolled, $3,697.68 CAD spend. Trailing 8-week averages: 55 applied, 9 consults booked, 7 roadmaps booked, 6 enrolled, $3,300 CAD spend.

Campaigns in the fixture: "Summer Shred — Broad" (CAD, 35% of spend), "Summer Shred — Retargeting" (20%), "Brand Search" (25%), "Referral" (no spend), "Website" (organic). The Meta ad account bills in CAD; Stripe collects about 63% in CAD and the rest in USD, converted at the Bank of Canada rate on each payment's date.

Decisions on record: applied is dated by the opportunity (F14); show rates are withheld under 90% coverage (F2); roles are read at query time (F4); the Meta account currency is CAD (F13); reporting currency is CAD (C1). Owner notes: none yet.

This brief is the same on every probe request so the second and later rounds read it from the prompt cache.`;

const PROBE_TOOL: BetaTool = {
  name: 'get_metric',
  description: 'Read one probe metric. Returns its value, unit, a ref to cite, and the name of the next metric to fetch (null when done).',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', enum: Object.keys(PROBE_METRICS) } },
    required: ['name'],
    additionalProperties: false,
  },
};

const PROBE_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    total: { type: 'integer' },
    refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'total', 'refs'],
  additionalProperties: false,
} as const;

const ProbeAnswer = z.object({ headline: z.string(), total: z.number().int(), refs: z.array(z.string()) });
const EXPECTED_TOTAL = Object.values(PROBE_METRICS).reduce((a, m) => a + m.value, 0);
const EXPECTED_REFS = Object.keys(PROBE_METRICS).map((k) => `probe:${k}`);

function runTool(name: string, input: unknown): string {
  const key = (input as { name?: string })?.name ?? '';
  const m = PROBE_METRICS[key];
  if (name !== 'get_metric' || !m) return JSON.stringify({ error: `unknown metric "${key}"` });
  return JSON.stringify({ name: key, value: m.value, unit: m.unit, ref: `probe:${key}`, next: m.next });
}

// ---------------------------------------------------------------------------

interface RoundResult {
  message: BetaMessage;
  deltaEvents: number;
}

class Tally {
  input = 0;
  output = 0;
  usd = 0;
  constructor(private model: string) {}
  add(usage: UsageLike) {
    const t = usageTotals(usage);
    this.input += t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
    this.output += t.outputTokens;
    this.usd += priceUsage(this.model, usage);
  }
  private mark = { input: 0, output: 0, usd: 0 };
  /** One line, priced with what was spent since the previous line (each check reports its own cost). */
  line(status: ProbeLine['status'], assumption: string, detail: string): ProbeLine {
    const l: ProbeLine = { status, assumption, model: this.model, inputTokens: this.input - this.mark.input, outputTokens: this.output - this.mark.output, usd: Math.round((this.usd - this.mark.usd) * 1e6) / 1e6, detail };
    this.mark = { input: this.input, output: this.output, usd: this.usd };
    return l;
  }
}

async function streamRound(client: Anthropic, params: ReturnType<typeof buildTurnRequest>): Promise<RoundResult> {
  const stream = client.beta.messages.stream(params);
  let deltaEvents = 0;
  for await (const event of stream) if (event.type === 'content_block_delta') deltaEvents += 1;
  const message = await stream.finalMessage();
  return { message, deltaEvents };
}

function describe(err: unknown, model: string): string {
  const text = describeError(err);
  if (model === 'claude-fable-5-1' && /retention/i.test(text)) return `${text} — Fable 5.1 needs 30-day data retention on the Anthropic org`;
  return text;
}

/**
 * Run the tool loop to a final answer in the given answer mode. Returns everything the checks need.
 */
async function runLoop(client: Anthropic, model: AnalystModel, answerMode: AnswerMode, tally: Tally) {
  const messages: BetaMessageParam[] = [{ role: 'user', content: 'Run the procedure. Start with get_metric("applied").' }];
  const rounds: RoundResult[] = [];
  let toolRounds = 0;
  let answer: z.infer<typeof ProbeAnswer> | null = null;
  let stop: string | null = null;
  for (let round = 0; round < 8; round++) {
    const params = buildTurnRequest({ model, effort: 'low', system: [PROBE_CONTRACT, PROBE_BRIEF], tools: [PROBE_TOOL], messages, answerSchema: PROBE_ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode, maxTokens: 4096 });
    const r = await streamRound(client, params);
    rounds.push(r);
    tally.add(r.message.usage as UsageLike);
    stop = r.message.stop_reason;
    const toolUses = r.message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    if (stop === 'refusal' || stop === 'max_tokens') break;
    if (answerMode === 'submit_answer') {
      const submit = toolUses.find((t) => t.name === SUBMIT_ANSWER_TOOL);
      if (submit) {
        answer = ProbeAnswer.parse(submit.input);
        messages.push(assistantTurn(r.message));
        break;
      }
    }
    if (toolUses.length === 0) {
      if (answerMode === 'format') {
        const text = r.message.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
        answer = ProbeAnswer.parse(JSON.parse(text));
      }
      messages.push(assistantTurn(r.message));
      break;
    }
    toolRounds += 1;
    messages.push(assistantTurn(r.message));
    messages.push({ role: 'user', content: toolUses.map((t) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: runTool(t.name, t.input) })) });
  }
  return { messages, rounds, toolRounds, answer, stop };
}

export async function runAnalystProbe(opts: { key: string | null; models?: AnalystModel[] }): Promise<{ lines: ProbeLine[]; ok: boolean; answerMode: Record<string, AnswerMode | 'neither'> }> {
  const lines: ProbeLine[] = [];
  const answerMode: Record<string, AnswerMode | 'neither'> = {};
  if (!opts.key) {
    lines.push({ status: 'SKIP', assumption: 'every assumption', model: null, inputTokens: 0, outputTokens: 0, usd: 0, detail: 'no Anthropic API key stored (Setup → Anthropic) — nothing was exercised' });
    return { lines, ok: false, answerMode };
  }
  const client = makeAnalystClient(opts.key);
  for (const model of opts.models ?? ANALYST_MODEL_OPTIONS) {
    const tally = new Tally(model);
    let loop: Awaited<ReturnType<typeof runLoop>> | null = null;
    // 1 + 2: auto tool choice with a strict tool, then a schema-valid structured answer after ≥ 3 tool rounds, streamed.
    try {
      loop = await runLoop(client, model, 'format', tally);
      const first = loop.rounds[0]?.message;
      const firstTool = first?.content.some((b) => b.type === 'tool_use');
      lines.push(tally.line(firstTool ? 'PASS' : 'FAIL', 'tool_choice auto + strict tool → the model calls the tool', firstTool ? `first round called ${first!.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.Beta.Messages.BetaToolUseBlock).name).join(', ')}` : `first round stop_reason=${first?.stop_reason ?? 'none'}, no tool_use`));
      const streamed = loop.rounds.reduce((a, r) => a + r.deltaEvents, 0);
      const ok = loop.answer !== null && loop.toolRounds >= 3 && loop.answer.total === EXPECTED_TOTAL && EXPECTED_REFS.every((r) => loop!.answer!.refs.includes(r));
      answerMode[model] = ok ? 'format' : 'neither';
      lines.push(
        tally.line(
          ok ? 'PASS' : 'FAIL',
          'output_config.format after ≥ 3 tool rounds, streamed → schema-valid answer',
          ok
            ? `${loop.toolRounds} tool rounds · ${streamed} stream deltas · total ${loop.answer!.total} (expected ${EXPECTED_TOTAL}) · refs ${loop.answer!.refs.join(',')}`
            : `${loop.toolRounds} tool rounds · stop_reason=${loop.stop} · answer=${loop.answer ? JSON.stringify(loop.answer) : 'none'} (expected total ${EXPECTED_TOTAL})`,
        ),
      );
    } catch (err) {
      answerMode[model] = 'neither';
      lines.push(tally.line('FAIL', 'output_config.format after ≥ 3 tool rounds, streamed → schema-valid answer', describe(err, model)));
      // The fallback named in the plan: a strict submit_answer tool under tool_choice auto.
      try {
        const fb = await runLoop(client, model, 'submit_answer', tally);
        const ok = fb.answer !== null && fb.toolRounds >= 3 && fb.answer.total === EXPECTED_TOTAL;
        if (ok) answerMode[model] = 'submit_answer';
        lines.push(tally.line(ok ? 'PASS' : 'FAIL', 'fallback: strict submit_answer tool under tool_choice auto', ok ? `${fb.toolRounds} tool rounds · total ${fb.answer!.total}` : `stop_reason=${fb.stop} · answer=${fb.answer ? JSON.stringify(fb.answer) : 'none'}`));
        loop = fb;
      } catch (err2) {
        lines.push(tally.line('FAIL', 'fallback: strict submit_answer tool under tool_choice auto', describe(err2, model)));
      }
    }
    if (!loop || loop.rounds.length < 2) {
      lines.push(tally.line('FAIL', 'cache_read_input_tokens > 0 from round 2', 'fewer than two rounds completed'));
      lines.push(tally.line('FAIL', 'thinking.display "updates" accepted', 'no rounds completed'));
      lines.push(tally.line('FAIL', 'drop_block accepted; input_transformations empty on an untouched history', 'fewer than two rounds completed'));
      lines.push(tally.line('FAIL', 'on-demand compaction returns a block; the next turn accepts it', 'no conversation to compact'));
    } else {
      // 3: prompt cache reads from round 2 (the prefix is unchanged between rounds).
      const reads = loop.rounds.slice(1).map((r) => r.message.usage.cache_read_input_tokens ?? 0);
      const writes = loop.rounds[0].message.usage.cache_creation_input_tokens ?? 0;
      lines.push(tally.line(reads.every((n) => n > 0) ? 'PASS' : 'FAIL', 'cache_read_input_tokens > 0 from round 2', `round 1 wrote ${writes} · rounds 2+ read ${reads.join(', ')}`));
      // 4: display "updates" — accepted; progress blocks are zero-or-more (Opus 5.5 rarely writes them; Fable does).
      const updates = loop.rounds.flatMap((r) => progressUpdates(r.message));
      lines.push(tally.line('PASS', 'thinking.display "updates" accepted', `${updates.length} progress update${updates.length === 1 ? '' : 's'} as text${updates[0] ? ` · e.g. "${updates[0].slice(0, 80)}"` : ' (zero is allowed; the model may skip any gap)'}`));
      // 5: drop_block set on every request; nothing was dropped because the history was replayed byte for byte.
      const transformations = loop.rounds.slice(1).flatMap((r) => inputTransformations(r.message));
      lines.push(tally.line(transformations.length === 0 ? 'PASS' : 'FAIL', 'drop_block accepted; input_transformations empty on an untouched history', transformations.length === 0 ? `${loop.rounds.length - 1} replays, 0 transformations` : `transformations: ${JSON.stringify(transformations)}`));
      // 6: on-demand compaction over the finished conversation, then one turn that carries the block.
      try {
        const compaction = await client.beta.messages.create(buildCompactionRequest({ model, effort: 'low', system: [PROBE_CONTRACT, PROBE_BRIEF], tools: [PROBE_TOOL], messages: loop.messages }, 'Summarize the probe conversation in three sentences. Keep every metric name, value and ref that was fetched, and the final total. Do not call tools; respond with the summary text only.'));
        tally.add(compaction.usage as UsageLike);
        const block = compaction.content.find((b) => b.type === 'compaction');
        if (compaction.stop_reason !== 'compaction' || !block) {
          lines.push(tally.line('FAIL', 'on-demand compaction returns a block; the next turn accepts it', `stop_reason=${compaction.stop_reason}, ${block ? 'block present' : 'no compaction block'}`));
        } else {
          const followUp = buildTurnRequest(
            {
              model,
              effort: 'low',
              system: [PROBE_CONTRACT, PROBE_BRIEF],
              tools: [PROBE_TOOL],
              messages: [assistantTurn(compaction), { role: 'user', content: 'From the summary alone (no tool calls): give the final answer again with the same total and refs.' }],
              answerSchema: PROBE_ANSWER_SCHEMA as unknown as Record<string, unknown>,
              answerMode: answerMode[model] === 'submit_answer' ? 'submit_answer' : 'format',
              maxTokens: 2048,
            },
            { carriesCompaction: true },
          );
          const after = await streamRound(client, followUp);
          tally.add(after.message.usage as UsageLike);
          const text = after.message.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
          const submit = after.message.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === SUBMIT_ANSWER_TOOL);
          const parsed = ProbeAnswer.safeParse(submit ? submit.input : text ? JSON.parse(text) : null);
          const summary = String((block as { content?: string | null }).content ?? '');
          const ok = parsed.success && parsed.data.total === EXPECTED_TOTAL;
          lines.push(tally.line(ok ? 'PASS' : 'FAIL', 'on-demand compaction returns a block; the next turn accepts it', ok ? `summary ${summary.length} chars · after the block: total ${parsed.data.total}` : `after the block: stop_reason=${after.message.stop_reason} · ${parsed.success ? `total ${parsed.data.total} (expected ${EXPECTED_TOTAL})` : parsed.error.issues[0]?.message ?? 'unparseable'}`));
        }
      } catch (err) {
        lines.push(tally.line('FAIL', 'on-demand compaction returns a block; the next turn accepts it', describe(err, model)));
      }
    }
    // 7: token counting on the same prompt shape.
    try {
      const count = await client.beta.messages.countTokens(buildCountRequest({ model, system: [PROBE_CONTRACT, PROBE_BRIEF], tools: [PROBE_TOOL], messages: [{ role: 'user', content: 'Run the procedure.' }] }));
      lines.push(tally.line(count.input_tokens > 0 ? 'PASS' : 'FAIL', 'token counting works on the turn prompt', `${count.input_tokens} input tokens`));
    } catch (err) {
      lines.push(tally.line('FAIL', 'token counting works on the turn prompt', describe(err, model)));
    }
  }
  return { lines, ok: lines.length > 0 && lines.every((l) => l.status === 'PASS'), answerMode };
}
