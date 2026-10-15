/**
 * Wave 2 tune-up 1 (2026-10-15): spend decisions by construction. One decision per gate row, account first then
 * the campaigns in gate order; a hold row is written by the server from the gate's refs; a may_change row keeps the
 * model's call (or holds "no change proposed"); stale data holds everything; actions with no gate are dropped with
 * a note. The smoke's `spend:` line is a function of the gates plus the model's may_change calls only.
 */
import { describe, it, expect } from 'vitest';
import { Ledger } from '@/lib/analyst/ledger';
import { applySpendDecisions, latestGates, spendDecisionsLine } from '@/lib/analyst/spendDecisions';
import { renderAnswer } from '@/lib/analyst/render';
import { verifyAnswer } from '@/lib/analyst/verify';
import type { Answer } from '@/lib/analyst/schema';

const T0 = '2026-10-15T10:00:00.000Z';
const gates = {
  window: { start: '2026-08-09', end: '2026-10-03', weeksUsed: 8, note: null },
  account: { campaign: 'account', platform: '', decision: 'may_change', basis: '12 tracked enrollments over 8 weeks with spend', reason: 'may change', trackedEnrollments: 12, weeksWithSpend: 8, weeksInWindow: 8, needsEnrollments: 0, needsWeeks: 0, spendCents: 2_000_000 },
  campaigns: [
    { campaign: 'July 16 VSL', platform: 'meta', decision: 'may_change', basis: '10 tracked enrollments over 8 weeks with spend', reason: 'may change', trackedEnrollments: 10, weeksWithSpend: 8, weeksInWindow: 8, needsEnrollments: 0, needsWeeks: 0, spendCents: 1_500_000 },
    { campaign: '(Sept 7) VSL Testing', platform: 'meta', decision: 'hold', basis: '2 of 4 tracked enrollments, 3 of 4 weeks with spend', reason: 'hold — needs 2 more', trackedEnrollments: 2, weeksWithSpend: 3, weeksInWindow: 8, needsEnrollments: 2, needsWeeks: 1, spendCents: 400_000 },
    { campaign: 'Scaling', platform: 'meta', decision: 'hold', basis: 'no spend in the window', reason: 'hold — no spend', trackedEnrollments: 0, weeksWithSpend: 0, weeksInWindow: 8, needsEnrollments: 4, needsWeeks: 4, spendCents: 0 },
  ],
};
const ledger = new Ledger();
ledger.add('r2', { kpis: { enrollments: { current: 8 } }, spendGates: gates }, T0, 'CAD');

const base = (actions: Answer['actions']): Answer => ({ kind: 'answer', headline: { text: 'x' }, sections: [{ key: 'do_this', body_md: 'y' }], actions, findings: [], note_proposals: [], clarifying_question: '' });
const action = (over: Partial<Answer['actions'][number]> = {}): Answer['actions'][number] => ({ action: 'Shift budget', why: 'because', owner: 'Jake', kind: 'spend', campaign: 'account', spend_change: 'shift', expected_impact: 'unknown', confidence: 'medium', metric: 'paid_cac', check_date: '2026-10-22', ...over });
const opts = { stale: false, checkDate: '2026-10-22' };

describe('spend decisions by construction', () => {
  it('reads the newest gate set from the ledger, account first, campaigns in the result order', () => {
    expect(latestGates(ledger)?.map((g) => [g.campaign, g.decision, g.needsEnrollments])).toEqual([
      ['account', 'may_change', 0],
      ['July 16 VSL', 'may_change', 0],
      ['(Sept 7) VSL Testing', 'hold', 2],
      ['Scaling', 'hold', 4],
    ]);
    const L2 = new Ledger();
    L2.add('r2', { spendGates: gates }, T0, 'CAD');
    L2.add('r5', { gates: { ...gates, campaigns: [{ ...gates.campaigns[1], decision: 'may_change', basis: '5 tracked enrollments over 4 weeks with spend' }] } }, T0, 'CAD');
    expect(latestGates(L2)?.map((g) => `${g.campaign}:${g.decision}`)).toEqual(['account:may_change', '(Sept 7) VSL Testing:may_change']);
    expect(latestGates(new Ledger())).toBeNull();
  });

  it('one decision per gate row in gate order: holds written by the server, may_change rows keep the model\'s call', () => {
    const answer = base([
      action({ kind: 'creative', campaign: '', spend_change: 'none', action: 'New creative' }),
      action({ campaign: '(Sept 7) VSL Testing', spend_change: 'increase', action: 'Scale Testing by 20%' }),
      action({ campaign: 'account', spend_change: 'increase', action: 'Raise the account budget' }),
    ]);
    const { answer: out, decisions, notes } = applySpendDecisions(answer, ledger, opts);
    expect(decisions.map((d) => [d.campaign, d.gate, d.decision, d.decidedBy])).toEqual([
      ['account', 'may_change', 'increase', 'model'],
      ['July 16 VSL', 'may_change', 'hold', 'server'],
      ['(Sept 7) VSL Testing', 'hold', 'hold', 'server'],
      ['Scaling', 'hold', 'hold', 'server'],
    ]);
    expect(decisions.every((d) => d.ref.startsWith('r2:data.spendGates.'))).toBe(true);
    // Spend decisions first (gate order), then the model's other actions.
    expect(out.actions.map((a) => a.action)).toEqual([
      'Raise the account budget',
      'Hold {r2:data.spendGates.campaigns[0].campaign}: no change proposed',
      'Hold {r2:data.spendGates.campaigns[1].campaign}: {r2:data.spendGates.campaigns[1].basis}',
      'Hold {r2:data.spendGates.campaigns[2].campaign}: {r2:data.spendGates.campaigns[2].basis}',
      'New creative',
    ]);
    expect(out.actions[2].why).toBe('The gate is computed by the server; it opens with {r2:data.spendGates.campaigns[1].needsEnrollments} more tracked enrollments and {r2:data.spendGates.campaigns[1].needsWeeks} more weeks with spend.');
    expect(notes).toEqual(['spend action "Scale Testing by 20%" (increase (Sept 7) VSL Testing) replaced by the gate\'s hold: 2 of 4 tracked enrollments, 3 of 4 weeks with spend']);
    // Server-written text is all tokens: it verifies by construction and renders from the ledger (campaign names with digits included).
    const v = verifyAnswer(out, ledger);
    expect(v.flagged).toEqual([]);
    const rendered = renderAnswer(out, ledger, v.flagged, decisions);
    expect(rendered.actions[2].action).toBe('Hold (Sept 7) VSL Testing: 2 of 4 tracked enrollments, 3 of 4 weeks with spend');
    expect(rendered.actions[2].why).toBe('The gate is computed by the server; it opens with 2 more tracked enrollments and 1 more weeks with spend.');
    expect(rendered.actions.map((a) => [a.gate, a.decidedBy])).toEqual([['may_change', 'model'], ['may_change', 'server'], ['hold', 'server'], ['hold', 'server'], [null, null]]);
    expect(spendDecisionsLine(decisions)).toBe('spend: increase account*, hold July 16 VSL, hold (Sept 7) VSL Testing, hold Scaling');
  });

  it('drops a spend action with no gate, a "none" spend change, and a second decision for the same campaign — each with a note', () => {
    const answer = base([
      action({ campaign: 'Retargeting', spend_change: 'decrease', action: 'Cut Retargeting' }),
      action({ campaign: 'account', spend_change: 'none', action: 'Keep the budget' }),
      action({ campaign: ' july 16 vsl ', spend_change: 'increase', action: 'Scale July 16' }),
      action({ campaign: 'July 16 VSL', spend_change: 'decrease', action: 'Cut July 16' }),
    ]);
    const { decisions, notes } = applySpendDecisions(answer, ledger, opts);
    expect(decisions.map((d) => `${d.decision} ${d.campaign}${d.decidedBy === 'model' ? '*' : ''}`)).toEqual(['hold account', 'increase July 16 VSL*', 'hold (Sept 7) VSL Testing', 'hold Scaling']);
    expect(notes).toEqual([
      'spend action "Keep the budget" dropped: spend_change is "none"',
      'spend action "Cut July 16" dropped: one decision per campaign (July 16 VSL already has "increase")',
      'spend action "Cut Retargeting" dropped: no spend gate for "Retargeting" in this conversation — fetch get_campaigns and name the campaign exactly as it gives it',
    ]);
  });

  it('stale data holds every row, decided by the server, and says so', () => {
    const { answer: out, decisions, notes } = applySpendDecisions(base([action({ campaign: 'account', spend_change: 'increase', action: 'Raise it' })]), ledger, { ...opts, stale: true });
    expect(decisions.map((d) => `${d.decision} ${d.campaign}${d.decidedBy === 'model' ? '*' : ''}`)).toEqual(['hold account', 'hold July 16 VSL', 'hold (Sept 7) VSL Testing', 'hold Scaling']);
    expect(out.actions[0].why).toBe('A data source is stale; no spend change until the sync completes.');
    expect(notes).toEqual(['spend action "Raise it" (increase account) replaced by a hold: a data source is stale']);
    expect(verifyAnswer(out, ledger).flagged).toEqual([]);
  });

  it('without any gate in the conversation there are no decisions and the model\'s spend actions are dropped', () => {
    const { answer: out, decisions, notes } = applySpendDecisions(base([action()]), new Ledger(), opts);
    expect(decisions).toEqual([]);
    expect(out.actions).toEqual([]);
    expect(notes[0]).toMatch(/no spend gate in this conversation/);
    expect(spendDecisionsLine([])).toBe('spend: none');
  });

  it('is deterministic: the same answer and gates twice give the same decisions and line', () => {
    const answer = base([action({ campaign: 'July 16 VSL', spend_change: 'shift', action: 'Shift to July 16' })]);
    const a = applySpendDecisions(answer, ledger, opts);
    const b = applySpendDecisions(answer, ledger, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(spendDecisionsLine(a.decisions)).toBe('spend: hold account, shift July 16 VSL*, hold (Sept 7) VSL Testing, hold Scaling');
  });
});
