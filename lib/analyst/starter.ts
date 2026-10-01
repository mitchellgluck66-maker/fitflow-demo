/**
 * The starter snapshot (tuning item 4, 2026-09-30). A NEW conversation opens with two tool results the
 * server fetched before the first request — r1 = get_data_health, r2 = get_scorecard for the last
 * complete Sun–Sat week vs the previous week, with the trailing 8-week baseline — so the common
 * questions ("how did last week go?") need 0–2 more calls instead of 5–11 rounds.
 *
 * They are real, cited tool results, not prose: the log opens with a short user instruction, a
 * fabricated assistant turn holding the two tool_use blocks (no thinking — none is needed for a
 * replayed call), and a user message with the two tool_result blocks followed by the owner's question
 * as a text block. The ledger is rebuilt from tool_results rows, so r1 / r2 verify like any other ref,
 * and the next live call is r3. On later turns the snapshot is simply older history; a ref fetched
 * before the newest sync marker is rejected with "re-fetch" as always.
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

export const STARTER_INSTRUCTION = 'Snapshot for this conversation, fetched by the server just now: data health (r1) and last complete week\'s scorecard vs the previous week with the 8-week baseline (r2). Cite them like any tool result; fetch more only when the question needs another period, a drill-down or people.';

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

/** The three log rows that open a new thread: instruction → assistant tool_use → tool_results + the question. */
export function starterRows(turnId: string, question: string, userTurn: string, results: StarterResult[]): NewMessage[] {
  const assistant: BetaMessageParam = { role: 'assistant', content: results.map((r) => ({ type: 'tool_use' as const, id: `starter_${r.ref}`, name: r.name, input: r.input })) };
  const user: BetaMessageParam = {
    role: 'user',
    content: [
      ...results.map((r) => ({ type: 'tool_result' as const, tool_use_id: `starter_${r.ref}`, content: JSON.stringify(r.result), ...(r.result.error && r.result.data === null ? { is_error: true } : {}) })),
      { type: 'text' as const, text: userTurn },
    ],
  };
  return [
    { turnId, role: 'user', apiJson: JSON.stringify({ role: 'user', content: STARTER_INSTRUCTION } satisfies BetaMessageParam), display: { starter: true } },
    { turnId, role: 'assistant', apiJson: JSON.stringify(assistant), display: { starter: true, tools: results.map((r) => ({ ref: r.ref, name: r.name, label: `Snapshot: ${r.name}` })) } },
    { turnId, role: 'tool_results', apiJson: JSON.stringify(user), display: { starter: true, refs: results.map((r) => r.ref), question } },
  ];
}

/** The same three messages for the token count before the turn runs. */
export function starterMessages(rows: ReturnType<typeof starterRows>): BetaMessageParam[] {
  return rows.map((r) => JSON.parse(r.apiJson) as BetaMessageParam);
}
