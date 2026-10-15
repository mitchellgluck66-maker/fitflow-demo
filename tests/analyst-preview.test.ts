/** The screenshot harness's canned panel states (Wave 2 item 8): built from the replay fixture into the panel's view shape; every state renders something; nothing but demo data. */
import { describe, it, expect } from 'vitest';
import { readFixtures } from '@/lib/analyst/replay';
import { previewPayload, PREVIEW_STATES, recordedAnswer } from '@/lib/analyst/preview';

describe('previewPayload', () => {
  const fixture = readFixtures()[0]?.fixture ?? null;
  it('every state is open with the right view and turns; the answer state carries the fixture\'s recorded, rendered answer', () => {
    for (const state of PREVIEW_STATES) {
      const p = previewPayload(state, fixture as never);
      expect(p.state).toBe(state);
      expect(p.open).toBe(true);
      expect(p.view).toBe(state === 'threads' ? 'threads' : 'chat');
      expect(p.turns.length).toBe(state === 'welcome' || state === 'threads' ? 0 : 1);
    }
    if (fixture) {
      const rec = recordedAnswer(fixture as never);
      expect(rec?.rendered.sections.length).toBeGreaterThan(0);
      const answer = previewPayload('answer', fixture as never);
      expect(answer.turns[0].answer).toEqual(rec?.rendered);
      expect(answer.turns[0].usage?.costUsd).toBe(fixture.turns[0].outcome.costUsd);
      expect(previewPayload('thinking', fixture as never).turns[0]).toMatchObject({ status: 'running', statuses: ['Reading the scorecard', 'Comparing to your 8-week baseline'] });
    }
    expect(previewPayload('explain', null).turns[0]).toMatchObject({ kind: 'explain', status: 'done', explain: { key: 'paid_cac' } });
    expect(previewPayload('error', null).turns[0]).toMatchObject({ status: 'failed', error: { retryable: true } });
    expect(previewPayload('confirm', null).turns[0]).toMatchObject({ status: 'needs_confirmation', confirmation: { estimateUsd: 4.1 } });
    expect(previewPayload('threads', null).threads).toHaveLength(3);
  });
});
