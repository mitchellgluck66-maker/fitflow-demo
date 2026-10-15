/**
 * The golden eval's scorers (Wave 2 item 12) — PURE. A numbers case passes when the ONE ref token in the answer's
 * headline resolves, in the ledger rebuilt from the turn's log, to the independent SQL's value (counts / cents exact,
 * ratios within 0.0005) and the verifier flagged nothing. An explain case passes with exactly the three sections, the
 * formula box equal to the engine's worked formula and nothing flagged. Behaviour cases check what the answer DID.
 */

import type { TurnOutcome } from './run';
import { ledgerFromLog } from './run';
import type { MessageRow } from './store';
import { refTokens } from './refToken';
import { EXPLAIN_SECTIONS } from './schema';
import type { ExpectedUnit } from './evalQuestions';
import type { ExplainInfo } from './prompts';

export interface Score {
  ok: boolean;
  got: string;
  expected: string;
  reason: string | null;
}

export const RATIO_TOLERANCE = 0.0005;

export function formatExpected(v: number | null, unit: ExpectedUnit): string {
  if (v === null) return 'withheld';
  if (unit === 'cents') return `${v} ¢`;
  if (unit === 'ratio') return v.toFixed(4);
  return String(v);
}

function sameValue(got: number, expected: number, unit: ExpectedUnit): boolean {
  if (unit === 'ratio') return Math.abs(got - expected) <= RATIO_TOLERANCE;
  return got === expected;
}

/** The headline's first ref token, resolved through the ledger. */
export function headlineValue(outcome: TurnOutcome, rows: MessageRow[]): { ref: string | null; value: number | null | undefined; unit: string | null; text: string } {
  const text = outcome.answer?.headline.text ?? '';
  const t = refTokens(text)[0];
  if (!t) return { ref: null, value: undefined, unit: null, text };
  const { ledger } = ledgerFromLog(rows);
  const e = ledger.get(t.ref);
  return { ref: t.ref, value: e ? (e.unit === 'text' ? undefined : e.value) : undefined, unit: e?.unit ?? null, text };
}

export function scoreNumbers(outcome: TurnOutcome, rows: MessageRow[], expected: number | null, unit: ExpectedUnit): Score {
  const exp = formatExpected(expected, unit);
  if (outcome.status !== 'done' || !outcome.answer) return { ok: false, got: outcome.error ?? outcome.status, expected: exp, reason: `the turn did not finish (${outcome.status})` };
  if (outcome.flagged.length) return { ok: false, got: `${outcome.flagged.length} flagged`, expected: exp, reason: `verifier flagged ${outcome.flagged.map((f) => `${f.kind} "${f.text}"`).join(', ')}` };
  const h = headlineValue(outcome, rows);
  const rendered = outcome.rendered?.headline ?? '';
  if (expected === null) {
    const says = /withheld|not available|no (spend|data|payments)|cannot|can't|awaiting|not recorded|unavailable/i.test(rendered);
    return h.ref === null || h.value === null ? { ok: says, got: rendered, expected: exp, reason: says ? null : 'the headline neither cites the withheld value nor says why it is withheld' } : { ok: false, got: `${h.ref} = ${h.value}`, expected: exp, reason: 'a value was shown for a withheld metric' };
  }
  if (h.ref === null) return { ok: false, got: rendered, expected: exp, reason: 'the headline carries no ref token (no number to check)' };
  if (h.value === undefined) return { ok: false, got: `${h.ref} (unknown or text ref)`, expected: exp, reason: 'the headline token does not resolve to a number' };
  if (h.value === null) return { ok: false, got: `${h.ref} = withheld`, expected: exp, reason: 'the headline cites a withheld value' };
  const ok = sameValue(h.value, expected, unit);
  return { ok, got: `${h.ref} = ${formatExpected(h.value, unit)}`, expected: exp, reason: ok ? null : 'the headline figure differs from the independent SQL' };
}

export function scoreVerdict(outcome: TurnOutcome, expectedVerdict: string): Score {
  const rendered = (outcome.rendered?.headline ?? '').toLowerCase();
  const ok = outcome.status === 'done' && outcome.flagged.length === 0 && rendered.includes(expectedVerdict.toLowerCase());
  return { ok, got: outcome.rendered?.headline ?? outcome.status, expected: expectedVerdict, reason: ok ? null : 'the headline does not carry the server\'s verdict word' };
}

export function scoreExplain(outcome: TurnOutcome, explainEvent: ExplainInfo | null, engine: { worked: string; value: number | null }): Score {
  if (outcome.status !== 'done' || !outcome.answer) return { ok: false, got: outcome.error ?? outcome.status, expected: 'three sections', reason: `the turn did not finish (${outcome.status})` };
  const keys = outcome.answer.sections.map((s) => s.key);
  if (keys.join(',') !== EXPLAIN_SECTIONS.join(',')) return { ok: false, got: keys.join(', '), expected: EXPLAIN_SECTIONS.join(', '), reason: 'not exactly What it is / What yours says / What to do' };
  if (outcome.flagged.length) return { ok: false, got: `${outcome.flagged.length} flagged`, expected: '0 flagged', reason: `verifier flagged ${outcome.flagged.map((f) => `${f.kind} "${f.text}"`).join(', ')}` };
  if (!explainEvent) return { ok: false, got: 'no explain event', expected: engine.worked, reason: 'the server emitted no formula box' };
  if (explainEvent.worked !== engine.worked || explainEvent.value !== engine.value) return { ok: false, got: explainEvent.worked, expected: engine.worked, reason: 'the formula box differs from the engine' };
  return { ok: true, got: explainEvent.worked, expected: engine.worked, reason: null };
}

/** Every rendered text of an answer, joined (for "does it mention X" checks). */
export function renderedText(outcome: TurnOutcome): string {
  const r = outcome.rendered;
  if (!r) return '';
  return [r.headline, ...r.sections.map((s) => s.body_md), ...r.actions.map((a) => `${a.action} ${a.why}`), ...r.findings.map((f) => f.finding), r.clarifying_question].join('\n');
}

export function scoreStale(outcomes: TurnOutcome[], firstEvents: Array<{ type: string; stale?: boolean }>): Score {
  const o = outcomes[0];
  const first = firstEvents.find((e) => e.type === 'notice');
  const noticeFirst = Boolean(first?.stale) && firstEvents.findIndex((e) => e.type === 'notice') <= 1;
  const allHold = o?.spendDecisions.every((d) => d.decision === 'hold' && d.decidedBy === 'server') ?? false;
  const ok = o?.status === 'done' && noticeFirst && allHold;
  return { ok, got: `notice stale=${String(first?.stale)} · decisions ${o?.spendDecisions.map((d) => `${d.decision}${d.decidedBy === 'model' ? '*' : ''}`).join(',') || 'none'}`, expected: 'stale notice first · every decision a server hold', reason: ok ? null : !noticeFirst ? 'the stale notice was not the first event' : 'a spend decision was not a server hold' };
}

export function scoreHealthy(outcomes: TurnOutcome[]): Score {
  const o = outcomes[0];
  if (!o || o.status !== 'done' || !o.answer) return { ok: false, got: o?.status ?? 'none', expected: 'done', reason: 'the turn did not finish' };
  const toDo = o.rendered?.sections.find((s) => s.key === 'what_to_do')?.body_md ?? '';
  const noAction = /no action needed/i.test(toDo);
  const actionsWithDates = o.answer.actions.length > 0 && o.answer.actions.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.check_date));
  const ok = o.flagged.length === 0 && (noAction || actionsWithDates);
  return { ok, got: noAction ? '"No action needed"' : `${o.answer.actions.length} action(s)`, expected: '"No action needed; flag it if …" or dated actions', reason: ok ? null : o.flagged.length ? 'flagged' : 'actions without a check date and no "No action needed"' };
}

export function scoreClarify(outcomes: TurnOutcome[]): Score {
  const o = outcomes[0];
  const ok = o?.status === 'done' && o.answer?.kind === 'clarify' && Boolean(o.answer.clarifying_question.trim());
  return { ok, got: o?.answer ? `${o.answer.kind}: ${o.rendered?.clarifying_question || o.rendered?.headline}` : o?.status ?? 'none', expected: 'kind clarify with one question', reason: ok ? null : 'the answer did not ask a clarifying question' };
}

/** The 5-turn context: the first answer names a campaign; every later answer mentions the same name. */
export function scoreContext(outcomes: TurnOutcome[], campaignNames: readonly string[]): Score {
  if (outcomes.length < 2 || outcomes.some((o) => o.status !== 'done')) return { ok: false, got: outcomes.map((o) => o.status).join(','), expected: 'every turn done', reason: 'a turn did not finish' };
  const first = renderedText(outcomes[0]);
  const named = campaignNames.find((n) => first.includes(n)) ?? null;
  if (!named) return { ok: false, got: first.slice(0, 120), expected: `one of ${campaignNames.join(' / ')}`, reason: 'the first answer named no campaign' };
  const lost = outcomes.slice(1).map((o, i) => (renderedText(o).includes(named) ? null : i + 2)).filter((x): x is number => x !== null);
  const ok = lost.length === 0;
  return { ok, got: `"${named}" in turns ${outcomes.map((o, i) => (renderedText(o).includes(named) ? i + 1 : `(${i + 1})`)).join(' ')}`, expected: `"${named}" in every turn`, reason: ok ? null : `turn${lost.length === 1 ? '' : 's'} ${lost.join(', ')} lost the campaign` };
}

export function scoreCampaignRow(outcomes: TurnOutcome[], campaign: string): Score {
  const o = outcomes[0];
  const ok = o?.status === 'done' && o.flagged.length === 0 && renderedText(o).includes(campaign);
  return { ok, got: o ? renderedText(o).slice(0, 120) : 'none', expected: `an answer about "${campaign}"`, reason: ok ? null : 'the answer does not name the campaign the row passed as context' };
}
