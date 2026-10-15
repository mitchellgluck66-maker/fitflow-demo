/**
 * The starter snapshot (tuning item 4, 2026-09-30). A NEW conversation opens with two tool results the
 * server fetched before the first request — r1 = get_data_health, r2 = get_scorecard for the last
 * complete Sun–Sat week vs the previous week, with the trailing 8-week baseline — so the common
 * questions ("how did last week go?") need 0–2 more calls instead of 5–11 rounds.
 *
 * Shape: ONE user message — a short instruction, one text block per result (`SNAPSHOT_PREFIX` + the
 * ToolResult JSON, exactly what a tool_result block would carry), then the owner's question. No
 * fabricated assistant turn: with thinking enabled the API requires the assistant turn before a
 * tool_result message to start with a thinking block, which a replayed call cannot have. The ledger
 * reads these blocks like tool results (`run#ledgerFromLog`), so r1 / r2 verify like any ref and the
 * next live call is r3. On later turns the snapshot is simply older history; a ref fetched before the
 * newest sync marker is rejected with "re-fetch" as always.
 */

import type { BetaMessageParam } from './api';
import { runAnalystTool, type AnalystTool, type Freshness, type ToolResult } from './tools';
import type { NewMessage } from './store';

export interface StarterCall {
  name: string;
  input: Record<string, unknown>;
}

export const STARTER_CALLS: readonly StarterCall[] = [
  { name: 'get_data_health', input: { range: { preset: 'last_week', start: '', end: '' } } },
  { name: 'get_scorecard', input: { range: { preset: 'last_week', start: '', end: '' }, compare: 'previous_period' } },
];

export const STARTER_INSTRUCTION = 'Snapshot for this conversation, fetched by the server just now: data health (r1) and last complete week\'s scorecard vs the previous week with the 8-week baseline (r2) follow as tool results. Cite them like any tool result (each starts with its ref). When they cover the question, answer in this response — no tool call, no calculate; fetch more only when the question needs another period, a drill-down or people.';

export interface StarterResult {
  ref: string;
  name: string;
  input: Record<string, unknown>;
  result: ToolResult;
}

/** Run the starter calls (in parallel) with the production tools; refs r1.. in list order. */
export async function runStarterCalls(freshness: Freshness, tools: readonly AnalystTool[], calls: readonly StarterCall[] = STARTER_CALLS): Promise<StarterResult[]> {
  return Promise.all(calls.map(async (c, i) => ({ ref: `r${i + 1}`, name: c.name, input: c.input, result: await runAnalystTool(c.name, c.input, { ref: `r${i + 1}`, freshness, resolveRef: () => undefined }, tools) })));
}

/** A snapshot block starts with this; the JSON after it is a ToolResult (the ledger parses it). */
export const SNAPSHOT_PREFIX = 'Snapshot tool result (cite it like any tool result):\n';

/** The one log row that opens a new thread: instruction → the results as text blocks → the question. */
export function starterRows(turnId: string, question: string, userTurn: string, results: StarterResult[]): NewMessage[] {
  const user: BetaMessageParam = {
    role: 'user',
    content: [
      { type: 'text' as const, text: STARTER_INSTRUCTION },
      ...results.map((r) => ({ type: 'text' as const, text: `${SNAPSHOT_PREFIX}${JSON.stringify(r.result)}` })),
      { type: 'text' as const, text: userTurn },
    ],
  };
  return [{ turnId, role: 'tool_results', apiJson: JSON.stringify(user), display: { starter: true, refs: results.map((r) => r.ref), tools: results.map((r) => ({ ref: r.ref, name: r.name, label: `Snapshot: ${r.name}` })), question } }];
}

/** The same message(s) for the token count before the turn runs. */
export function starterMessages(rows: ReturnType<typeof starterRows>): BetaMessageParam[] {
  return rows.map((r) => JSON.parse(r.apiJson) as BetaMessageParam);
}
