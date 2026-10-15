/**
 * The Analyst service (plan items 5–7): prepares a turn (thread, brief,
 * freshness, page context, the explain payload, the cost estimate and the cap
 * decision), runs it with the loop, resumes it after `continue` or a cost
 * confirmation, and sweeps orphaned turns (amendment 1). Routes and the smoke
 * call this; nothing here knows about HTTP.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { ANALYST_CONTRACT, composeUserTurn, type PageContext } from './prompts';
import { effortForThread, getAnalystConfig, type AnalystModel } from './config';
import { makeAnalystClient, buildCountRequest, loopClient } from './api';
import { currentBrief } from './briefService';
import { ANALYST_TOOLS, ANALYST_TOOL_DEFINITIONS, type Freshness } from './tools';
import { runStarterCalls, starterMessages, starterRows, STARTER_CALLS } from './starter';
import { runAnalystTurn, sweepOrphanTurns, ORPHAN_REASON, type AnalystClient, type AnalystEvent, type RunDeps, type TurnOutcome } from './run';
import { analystStore, type AnalystStore, type ThreadRow, type TurnKind, type TurnRow } from './store';
import { calibrationFactor, CALIBRATION_RUNS, capDecision, estimateRunUsd, formatUsd, prefixState, type RunEstimate } from './cost';
import { freshnessSummary, readSyncStatus } from '../sync/sourceFreshness';
import { readMarker, type MarkerFamily } from '../sync/markers';
import { getTimezone } from '../settings';
import { todayInTimezone, rangeFromParams } from '../dates';
import { glossaryEntry } from '../metrics/glossary';
import { saveProposals } from './notes';
import { loadMetricsInput } from '../metrics/load';
import { describeError } from '../anthropic/client';

export interface TurnRequest {
  threadId?: string | null;
  clientTurnId: string;
  question: string;
  kind: TurnKind;
  context?: PageContext | null;
  /** For kind explain: the glossary key. */
  explainKey?: string | null;
  preset?: { name: string; instructions: string } | null;
  /** 'deep' = the Fable model for a NEW thread; ignored on an existing thread (one model per thread). */
  depth?: 'default' | 'deep';
  /** The USD amount the owner confirmed for this run (after a needs_confirmation). */
  confirmedUsd?: number | null;
}

export type PrepareResult =
  | { ok: true; thread: ThreadRow; turn: TurnRow; created: boolean; estimate: RunEstimate; allowedUsd: number; deps: RunDeps }
  | { ok: false; status: 'needs_confirmation'; thread: ThreadRow; estimate: RunEstimate; reason: string; spentMonthUsd: number }
  | { ok: false; status: 'not_configured' | 'no_brief' | 'busy' | 'error'; message: string; thread?: ThreadRow | null };

/** The newest sync-marker time — a ref fetched before it is stale (verify → "re-fetch"). */
export async function newestMarkerAt(): Promise<string | null> {
  const families: MarkerFamily[] = ['ghl.opportunities', 'ghl.appointments', 'meta.spend', 'stripe.payments'];
  const markers = await Promise.all(families.map((f) => readMarker(f)));
  const times = markers.filter((m): m is NonNullable<typeof m> => Boolean(m)).map((m) => m.completedAt);
  return times.length ? times.sort()[times.length - 1] : null;
}

export async function currentFreshness(): Promise<Freshness> {
  return freshnessSummary(await readSyncStatus());
}

/** Everything a turn needs, decided server-side; the cap check before anything is spent. */
export interface PrepareOptions {
  store?: AnalystStore;
  client?: AnalystClient;
  /** Token counter (the real count endpoint by default; tests stub it). */
  countTokens?: (params: ReturnType<typeof buildCountRequest>) => Promise<number>;
  /** The clock for the warm/cold prefix check (tests). */
  now?: Date;
  onEvent?: (e: AnalystEvent) => void;
  /** Item 4: the snapshot calls a NEW thread opens with (STARTER_CALLS by default; [] = none). */
  starterCalls?: readonly { name: string; input: Record<string, unknown> }[];
  /** Item 6: save the answer's note_proposals as proposed notes (default true; the smoke passes its own handler). */
  onProposals?: ((texts: string[]) => Promise<{ saved: number; skipped: number }>) | null;
}

export async function prepareTurn(req: TurnRequest, opts: PrepareOptions = {}): Promise<PrepareResult> {
  const store = opts.store ?? analystStore();
  const config = await getAnalystConfig();
  if (!config.configured || !config.key) return { ok: false, status: 'not_configured', message: 'Connect Anthropic in Setup — the Analyst needs an API key.' };
  const brief = await currentBrief();
  if (!brief) return { ok: false, status: 'no_brief', message: "The business brief hasn't been built yet · Build now (Setup → Analyst)." };

  await sweepAndRecord(store);

  let thread = req.threadId ? await store.getThread(req.threadId) : null;
  if (req.threadId && !thread) return { ok: false, status: 'error', message: `No thread "${req.threadId}"` };
  if (!thread) {
    const model: AnalystModel = req.depth === 'deep' ? config.modelDeep : config.modelDefault;
    thread = await store.createThread({ model, effort: effortForThread({ kind: req.kind, model, settingEffort: config.effort }), answerMode: config.answerMode, briefHash: brief.hash });
  } else {
    const live = await store.liveTurn(thread.id);
    if (live && live.status === 'running' && live.clientTurnId !== req.clientTurnId) return { ok: false, status: 'busy', message: 'This thread is answering', thread };
  }

  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const freshness = await currentFreshness();
  const staleBefore = await newestMarkerAt();

  let explain: NonNullable<Parameters<typeof composeUserTurn>[0]['explain']> | null = null;
  if (req.kind === 'explain') {
    const e = glossaryEntry(req.explainKey ?? '');
    if (!e) return { ok: false, status: 'error', message: `Unknown metric "${req.explainKey ?? ''}"`, thread };
    const range = req.context?.range ? rangeFromParams({ start: req.context.range.start, end: req.context.range.end }, today) : rangeFromParams({ range: 'last_week' }, today);
    const input = await loadMetricsInput({ start: range.start, end: range.end, timezone });
    const w = e.worked(input, range, (req.context?.mode as 'period' | 'cohort' | undefined) ?? 'period');
    explain = { key: e.key, label: e.label, definition: e.definition, differsFrom: e.differsFrom, formula: e.formula, worked: w.text, value: w.value, reason: w.reason, maturing: e.maturing };
  }
  const userTurn = composeUserTurn({ question: req.question, kind: req.kind === 'ask' ? 'answer' : req.kind, context: req.context ?? null, healthLine: freshness.line, explain, preset: req.preset ?? null, today, timezone });

  // Estimate from a real token count of the prefix + history; the count endpoint is free.
  const client: AnalystClient = opts.client ?? loopClient(makeAnalystClient(config.key));
  const rows = await store.listMessages(thread.id);
  const history = rows.length ? (await import('./run')).historyFromLog(rows).messages : [];
  // Item 4: a NEW thread opens with the snapshot (r1 data health, r2 last week's scorecard), fetched here so the
  // count below includes it. Its rows carry the user turn; the turn id is filled in once the turn exists.
  const starter = rows.length === 0 && (opts.starterCalls ?? STARTER_CALLS).length > 0 ? await runStarterCalls(freshness, ANALYST_TOOLS, opts.starterCalls ?? STARTER_CALLS) : null;
  const starterPreview = starter ? starterRows('pending', req.question, userTurn, starter) : null;
  const newMessages = starterPreview ? starterMessages(starterPreview) : [{ role: 'user' as const, content: userTurn }];
  let promptTokens: number;
  try {
    const key = config.key;
    const count = opts.countTokens ?? (async (params) => (await makeAnalystClient(key).beta.messages.countTokens(params)).input_tokens);
    promptTokens = await count(buildCountRequest({ model: thread.model, system: [ANALYST_CONTRACT, brief.text], tools: [...ANALYST_TOOL_DEFINITIONS], messages: [...history, ...newMessages] }));
  } catch (err) {
    // A failed count must not block the owner: estimate from the stored brief count and the text sizes, and say so.
    promptTokens = (brief.tokens ?? Math.ceil(brief.text.length / 3.5)) + Math.ceil((ANALYST_CONTRACT.length + newMessages.reduce((a, m) => a + JSON.stringify(m).length, 0) + rows.reduce((a, r) => a + r.apiJson.length, 0)) / 3.5);
    opts.onEvent?.({ type: 'status', text: `Token count unavailable (${describeError(err)}); the estimate uses text sizes.` });
  }
  const kind = req.kind === 'ask' ? 'ask' : req.kind;
  // Oct 4 item 5: price the prefix as a cache hit when a turn with this brief on this model finished inside the TTL,
  // else as the TTL's write; the calibration (median actual ÷ estimate) comes from completed runs of the same kind
  // AND prefix state.
  const prefix = prefixState({ model: thread.model, lastFinishedAt: await store.lastFinishedAt(thread.model, brief.hash), now: opts.now ?? new Date() });
  const estimate = estimateRunUsd(thread.model, promptTokens, kind, calibrationFactor(await store.recentEstimates(req.kind, CALIBRATION_RUNS, prefix)), prefix);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const spentMonthUsd = await store.spentUsdSince(monthStart);
  const cap = capDecision({ estimateUsd: estimate.usd, capRunUsd: config.capRunUsd, spentMonthUsd, capMonthUsd: config.capMonthUsd, confirmedUsd: req.confirmedUsd ?? null });
  if (!cap.allowed) return { ok: false, status: 'needs_confirmation', thread, estimate, reason: cap.reason!, spentMonthUsd };
  const allowedUsd = req.confirmedUsd ?? Math.max(config.capRunUsd, estimate.usd);

  const { turn, created } = await store.createTurn({ threadId: thread.id, clientTurnId: req.clientTurnId, question: req.question, kind: req.kind, pageContext: (req.context as Record<string, unknown> | null) ?? null });
  if (created) await store.updateTurn(turn.id, { estimateUsd: estimate.usd, prefix, briefHash: brief.hash });
  const onProposals =
    opts.onProposals === null
      ? undefined
      : (opts.onProposals ??
        (async (texts: string[]) => {
          const r = await saveProposals(texts, { threadId: thread!.id, turnId: turn.id });
          return { saved: r.saved.length, skipped: r.skipped };
        }));
  const keyForCount = config.key;
  const countVisible = opts.countTokens
    ? async (text: string) => opts.countTokens!(buildCountRequest({ model: thread!.model, system: ['', ''], tools: [], messages: [{ role: 'user', content: text }] }))
    : async (text: string) => (await makeAnalystClient(keyForCount).beta.messages.countTokens({ model: thread!.model, messages: [{ role: 'user', content: text }] })).input_tokens;
  const deps: RunDeps = { store, client, contract: ANALYST_CONTRACT, brief: { text: brief.text, hash: brief.hash }, tools: ANALYST_TOOLS, freshness, staleBefore, userTurn, allowedUsd, onEvent: opts.onEvent, starterRows: starter ? starterRows(turn.id, req.question, userTurn, starter) : null, explain, onProposals, countTokens: countVisible };
  return { ok: true, thread, turn, created, estimate, allowedUsd, deps };
}

/** Run (or resume) a prepared turn. Safe to call for an existing turn: a done turn returns at once. */
export async function executeTurn(threadId: string, turnId: string, deps: RunDeps): Promise<TurnOutcome> {
  return runAnalystTurn(threadId, turnId, deps);
}

/** Resume after `continue` (time budget) or a cost confirmation. */
export async function resumeTurn(turnId: string, opts: { confirmedUsd?: number | null; store?: AnalystStore; client?: AnalystClient; onEvent?: (e: AnalystEvent) => void } = {}): Promise<TurnOutcome | { ok: false; message: string }> {
  const store = opts.store ?? analystStore();
  const turn = await store.getTurn(turnId);
  if (!turn) return { ok: false, message: `No turn "${turnId}"` };
  const thread = await store.getThread(turn.threadId);
  const config = await getAnalystConfig();
  const brief = await currentBrief();
  if (!thread || !config.key || !brief) return { ok: false, message: 'Cannot resume: the thread, the key or the brief is missing' };
  if (turn.status === 'needs_confirmation') {
    if (opts.confirmedUsd === null || opts.confirmedUsd === undefined) return { ok: false, message: 'This turn is waiting for a cost confirmation' };
    await store.updateTurn(turnId, { status: 'running' });
  } else if (turn.status !== 'running') return { ok: false, message: `Turn is ${turn.status}` };
  const freshness = await currentFreshness();
  const deps: RunDeps = {
    store,
    client: opts.client ?? loopClient(makeAnalystClient(config.key)),
    contract: ANALYST_CONTRACT,
    brief: { text: brief.text, hash: brief.hash },
    tools: ANALYST_TOOLS,
    freshness,
    staleBefore: await newestMarkerAt(),
    allowedUsd: opts.confirmedUsd ?? Math.max(config.capRunUsd, turn.costUsd),
    onEvent: opts.onEvent,
    onProposals: async (texts) => {
      const r = await saveProposals(texts, { threadId: turn.threadId, turnId });
      return { saved: r.saved.length, skipped: r.skipped };
    },
  };
  return runAnalystTurn(turn.threadId, turnId, deps);
}

export const ORPHAN_INCIDENT_KIND = 'analyst_turn_failed';

/** Amendment 1: sweep orphaned turns and open/refresh ONE incident per orphaned turn. Called on every read, list, new turn and in the dispatch. */
export async function sweepAndRecord(store: AnalystStore = analystStore(), now: Date = new Date()): Promise<TurnRow[]> {
  const swept = await sweepOrphanTurns(store, now);
  for (const t of swept) {
    try {
      const [open] = await db.select({ id: syncIncidents.id }).from(syncIncidents).where(and(eq(syncIncidents.kind, ORPHAN_INCIDENT_KIND), isNull(syncIncidents.resolvedAt), eq(syncIncidents.message, orphanMessage(t)))).limit(1);
      if (!open) await db.insert(syncIncidents).values({ kind: ORPHAN_INCIDENT_KIND, severity: 'warning', message: orphanMessage(t), details: { turnId: t.id, threadId: t.threadId, question: t.question, rounds: t.rounds, costUsd: t.costUsd, at: now.toISOString() } });
    } catch {
      /* incident bookkeeping never breaks the sweep */
    }
  }
  return swept;
}

function orphanMessage(t: TurnRow): string {
  return `Analyst turn ${t.id} failed: ${ORPHAN_REASON} ("${t.question.slice(0, 60)}"; ${t.rounds} rounds, ${formatUsd(t.costUsd)} spent)`;
}

/** The dispatch step: the 5-minute sweep, hourly, so it never depends on the panel being open. */
export async function runAnalystSweepStep(): Promise<{ swept: number; reason: string }> {
  const swept = await sweepAndRecord();
  return { swept: swept.length, reason: swept.length ? `${swept.length} orphaned turn${swept.length === 1 ? '' : 's'} marked failed` : 'no orphaned turns' };
}
