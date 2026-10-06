/**
 * Record / replay (tuning item 9, 2026-09-30). `npm run smoke:analyst -- --record` keeps a live run's
 * API responses, tool results and log rows under tests/fixtures/analyst-replay/; the vitest suite
 * tests/analyst-replay.test.ts plays them back through the REAL loop (`runAnalystTurn`) on the
 * in-memory store at $0 — the verifier, the repair path, the display strings, persistence and the
 * cost math all run on what the model really returned.
 *
 * A fixture carries the WIRE HASH of the code that recorded it: the contract, the tool definitions,
 * the answer schema and the request shape (everything that decides what the model is sent, minus the
 * brief and the messages, which change with the data). When the current code's hash differs the
 * suite fails with "fixtures stale: re-record" — a replay of responses to a prompt we no longer send
 * proves nothing.
 *
 * Nothing secret is recorded (responses and tool results carry no credentials). A fixture is recorded
 * ONLY against the seeded demo tenant, so it never holds customer data (lib/analyst/fixtureGuard.ts).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { buildTurnRequest, type BetaMessage, type BetaMessageParam } from './api';
import { ANALYST_CONTRACT } from './prompts';
import { ANALYST_TOOLS, ANALYST_TOOL_DEFINITIONS, type AnalystTool, type Freshness, type ToolResult } from './tools';
import { ANSWER_SCHEMA } from './schema';
import { SNAPSHOT_PREFIX } from './starter';
import { countRepairs, runAnalystTurn, type AnalystClient, type AnalystEvent, type TurnOutcome } from './run';
import { MemoryAnalystStore, type MessageRow, type NewMessage } from './store';
import type { AnalystModel, AnswerMode, Effort } from './config';
import type { Flag } from './verify';

export const REPLAY_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'analyst-replay');
export const STALE_MESSAGE = 'fixtures stale: re-record (npm run smoke:analyst -- --record)';

/** The hash of everything that decides the request apart from the brief and the messages. */
export function analystWireHash(answerMode: AnswerMode = 'format'): string {
  const sample = buildTurnRequest({ model: 'claude-opus-5-5', effort: 'high', system: ['', ''], tools: [...ANALYST_TOOL_DEFINITIONS], messages: [{ role: 'user', content: 'x' }], answerSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>, answerMode, maxTokens: 1 });
  const { system: _s, messages: _m, max_tokens: _t, ...shape } = sample as unknown as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify({ contract: ANALYST_CONTRACT, tools: ANALYST_TOOL_DEFINITIONS, answerSchema: ANSWER_SCHEMA, shape })).digest('hex');
}

export interface RecordedTurn {
  question: string;
  kind: string;
  userTurn: string;
  freshness: Freshness;
  /** Every API response of the turn, in order (stream() results, then compaction create() results). */
  responses: BetaMessage[];
  compactions: BetaMessage[];
  /** The log rows this turn appended, as stored (api_json byte for byte). */
  rows: Array<Pick<MessageRow, 'role' | 'apiJson' | 'display'>>;
  outcome: { status: TurnOutcome['status']; headline: string | null; flagged: Flag[]; repairs: number; rounds: number; costUsd: number; usage: TurnOutcome['usage']; sections: string[]; proposals: string[] };
}

export interface ReplayFixture {
  version: 1;
  recordedAt: string;
  wireHash: string;
  model: AnalystModel;
  effort: Effort;
  answerMode: AnswerMode;
  /** The kind of database the smoke ran against (never the host). */
  database: string;
  /** Required: the fixture was recorded against the seeded demo tenant (design review 2026-10-03, B). Anything else is refused. */
  tenant: 'demo';
  turns: RecordedTurn[];
}

export const NOT_DEMO_MESSAGE = 'fixture not from the demo tenant: re-record (npm run smoke:analyst -- --record) — a fixture never holds customer data';

/** Wrap the live client so every response is kept, in order, per turn. */
export function recordingClient(inner: AnalystClient): AnalystClient & { responses: BetaMessage[]; compactions: BetaMessage[]; reset(): void } {
  const responses: BetaMessage[] = [];
  const compactions: BetaMessage[] = [];
  return {
    responses,
    compactions,
    reset() {
      responses.length = 0;
      compactions.length = 0;
    },
    beta: {
      messages: {
        stream: (params) => {
          const s = inner.beta.messages.stream(params);
          return {
            [Symbol.asyncIterator]: () => s[Symbol.asyncIterator](),
            finalMessage: async () => {
              const m = await s.finalMessage();
              responses.push(JSON.parse(JSON.stringify(m)) as BetaMessage);
              return m;
            },
          };
        },
        create: async (params) => {
          const m = await inner.beta.messages.create(params);
          compactions.push(JSON.parse(JSON.stringify(m)) as BetaMessage);
          return m;
        },
      },
    },
  };
}

export function fixturePath(name: string): string {
  return path.join(REPLAY_DIR, `${name}.json`);
}

export function writeFixture(name: string, fixture: ReplayFixture): string {
  fs.mkdirSync(REPLAY_DIR, { recursive: true });
  const p = fixturePath(name);
  fs.writeFileSync(p, `${JSON.stringify(fixture, null, 2)}\n`);
  return p;
}

export function readFixtures(dir = REPLAY_DIR): Array<{ name: string; fixture: ReplayFixture }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ''), fixture: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ReplayFixture }));
}

/** The recorded tool results by ref (r1, r2, …) across every turn of a fixture — the replay tools answer from these. */
export function recordedToolResults(fixture: ReplayFixture): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  for (const t of fixture.turns) {
    for (const r of t.rows) {
      if (r.role !== 'tool_results') continue;
      const msg = JSON.parse(r.apiJson) as { content?: Array<{ type: string; content?: string; text?: string }> };
      for (const b of msg.content ?? []) {
        const json = b.type === 'tool_result' && typeof b.content === 'string' ? b.content : b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(SNAPSHOT_PREFIX) ? b.text.slice(SNAPSHOT_PREFIX.length) : null;
        if (json === null) continue;
        try {
          const res = JSON.parse(json) as ToolResult;
          if (res && typeof res.ref === 'string') out.set(res.ref, res);
        } catch {
          /* an unparseable result has no ref */
        }
      }
    }
  }
  return out;
}

/** The real tool definitions (so input validation runs) answering from the recording; an unknown ref is an error result. */
export function replayTools(results: Map<string, ToolResult>): AnalystTool[] {
  return ANALYST_TOOLS.map((t) => ({
    ...t,
    run: async (_input, ctx) => {
      const r = results.get(ctx.ref);
      if (!r) return { range: null, currency: 'CAD', fx: '', data: null, error: `replay: no recorded result for ${ctx.ref} (${t.definition.name}) — the loop diverged from the recording` };
      const { ref: _ref, freshness: _f, ...rest } = r;
      return rest;
    },
  }));
}

/** A scripted client that returns the recorded responses in order; running out is an error (divergence). */
export function replayClient(turn: RecordedTurn): AnalystClient {
  const responses = [...turn.responses];
  const compactions = [...turn.compactions];
  return {
    beta: {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
          },
          finalMessage: async () => {
            const next = responses.shift();
            if (!next) throw new Error('replay: the loop asked for more responses than were recorded — the loop diverged from the recording');
            return next;
          },
        }),
        create: async () => {
          const next = compactions.shift();
          if (!next) throw new Error('replay: a compaction request was made but none was recorded');
          return next;
        },
      },
    },
  };
}

export interface ReplayTurnResult {
  outcome: TurnOutcome;
  events: AnalystEvent[];
  rows: MessageRow[];
  repairs: number;
}

/**
 * Play one fixture through the real loop on a fresh in-memory store: the first turn opens with the recorded
 * snapshot rows (when the recording had them), every later turn with its recorded user turn.
 */
export async function replayFixture(fixture: ReplayFixture): Promise<ReplayTurnResult[]> {
  const store = new MemoryAnalystStore();
  const thread = await store.createThread({ model: fixture.model, effort: fixture.effort, answerMode: fixture.answerMode, briefHash: 'replay' });
  const results = recordedToolResults(fixture);
  const tools = replayTools(results);
  const out: ReplayTurnResult[] = [];
  for (let i = 0; i < fixture.turns.length; i++) {
    const t = fixture.turns[i];
    const { turn } = await store.createTurn({ threadId: thread.id, clientTurnId: `replay-${i + 1}`, question: t.question, kind: t.kind as 'ask' | 'explain' | 'report', pageContext: null });
    const events: AnalystEvent[] = [];
    const starter = i === 0 && t.rows[0]?.display?.starter ? [{ turnId: turn.id, role: t.rows[0].role, apiJson: t.rows[0].apiJson, display: t.rows[0].display } satisfies NewMessage] : null;
    const outcome = await runAnalystTurn(thread.id, turn.id, {
      store,
      client: replayClient(t),
      contract: ANALYST_CONTRACT,
      brief: { text: '(replay — the brief is not part of a replay)', hash: 'replay' },
      tools,
      freshness: t.freshness,
      staleBefore: null,
      userTurn: t.userTurn,
      starterRows: starter,
      allowedUsd: 100,
      retryDelayMs: 1,
      onEvent: (e) => events.push(e),
      onProposals: async (texts) => ({ saved: 0, skipped: texts.length }),
    });
    const rows = (await store.listMessages(thread.id)).filter((r) => r.turnId === turn.id);
    out.push({ outcome, events, rows, repairs: countRepairs(events) });
  }
  return out;
}

/** The checks a replayed turn must pass against its recording (pure). Returns the differences, empty when faithful. */
export function compareReplay(recorded: RecordedTurn, replayed: ReplayTurnResult): string[] {
  const diffs: string[] = [];
  const o = replayed.outcome;
  if (o.status !== recorded.outcome.status) diffs.push(`status ${o.status} ≠ recorded ${recorded.outcome.status}`);
  const headline = o.answer?.headline.text ?? null;
  if (headline !== recorded.outcome.headline) diffs.push(`headline "${headline}" ≠ recorded "${recorded.outcome.headline}"`);
  if (o.flagged.length !== recorded.outcome.flagged.length) diffs.push(`${o.flagged.length} flagged ≠ recorded ${recorded.outcome.flagged.length}`);
  if (replayed.repairs !== recorded.outcome.repairs) diffs.push(`${replayed.repairs} repairs ≠ recorded ${recorded.outcome.repairs}`);
  if (o.rounds !== recorded.outcome.rounds) diffs.push(`${o.rounds} rounds ≠ recorded ${recorded.outcome.rounds}`);
  if (Math.abs(o.costUsd - recorded.outcome.costUsd) > 1e-6) diffs.push(`cost ${o.costUsd} ≠ recorded ${recorded.outcome.costUsd}`);
  const roles = replayed.rows.map((r) => r.role).join(',');
  const recordedRoles = recorded.rows.map((r) => r.role).join(',');
  if (roles !== recordedRoles) diffs.push(`log rows [${roles}] ≠ recorded [${recordedRoles}]`);
  // Every assistant / tool_results row is byte-identical to the recording (the API log is replayable).
  recorded.rows.forEach((r, i) => {
    const got = replayed.rows[i];
    if (got && r.role !== 'user' && got.apiJson !== r.apiJson) diffs.push(`row ${i + 1} (${r.role}) api_json differs from the recording`);
  });
  const sections = o.answer?.sections.map((s) => s.key) ?? [];
  if (sections.join(',') !== recorded.outcome.sections.join(',')) diffs.push(`sections [${sections.join(',')}] ≠ recorded [${recorded.outcome.sections.join(',')}]`);
  return diffs;
}

/** The stable description of one BetaMessageParam for a fixture file name / summary. */
export function summarizeRows(rows: Array<Pick<MessageRow, 'role'>>): string {
  return rows.map((r) => r.role).join(' → ');
}

export type { BetaMessageParam };
