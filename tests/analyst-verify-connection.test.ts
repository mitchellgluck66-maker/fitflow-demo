/**
 * Setup → Analyst "Verify" (plan item 8, Definition of done §4): the same
 * streamed tool path the feature uses, with the exact messages.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { setSetting } from '@/lib/settings';
import { ANTHROPIC_KEYS } from '@/lib/anthropic/config';
import { rebuildBrief } from '@/lib/analyst/briefService';
import { verifyAnalystConnection } from '@/lib/analyst/verifyConnection';
import type { AnalystClient } from '@/lib/analyst/run';
import type { BetaMessage } from '@/lib/analyst/api';
import type Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';

const scripted = (msgs: BetaMessage[]): AnalystClient => ({
  beta: {
    messages: {
      stream: () => {
        const next = msgs.shift();
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
          },
          finalMessage: async () => next!,
        };
      },
      create: async () => msgs[0],
    },
  },
});
const m = (content: unknown[], stop = 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } }) as unknown as BetaMessage;
const good = JSON.stringify({ kind: 'answer', headline: { text: 'Connected.', ref: '' }, sections: [{ key: 'what_happened', body_md: 'The connection works.', numbers: [] }], actions: [], findings: [], note_proposals: [], clarifying_question: '' });

beforeAll(async () => {
  await runMigrations();
});

describe('verifyAnalystConnection', () => {
  it('names the missing key, then the missing brief', async () => {
    expect((await verifyAnalystConnection()).message).toBe('Verification failed: no Anthropic API key stored (Setup → Anthropic)');
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test', { secret: true });
    expect((await verifyAnalystConnection()).message).toBe("Verification failed: the business brief hasn't been built yet · Build now");
  });
  it('"Connected" only after a real tool call and a verified structured answer; an answer without a tool call fails', async () => {
    await rebuildBrief({ trigger: 'manual', countTokens: false });
    const ok = await verifyAnalystConnection({ client: scripted([m([{ type: 'tool_use', id: 't1', name: 'get_notes', input: {} }], 'tool_use'), m([{ type: 'text', text: good }])]) });
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/^Connected · verified with a streamed tool call · claude-opus-5-5 · get_notes · /);
    const noTool = await verifyAnalystConnection({ client: scripted([m([{ type: 'text', text: good }])]) });
    expect(noTool).toMatchObject({ ok: false, message: 'Verification failed: the model answered without calling a tool (tool_choice auto did not produce a call)' });
    const refused = await verifyAnalystConnection({ client: scripted([m([], 'refusal')]) });
    expect(refused.message).toBe('Verification failed: Claude declined the request.');
  });
  it('the Setup page mounts the Analyst card, which shows the gaps checklist and the answer-mode setting', () => {
    expect(fs.readFileSync('app/setup/page.tsx', 'utf8')).toContain('<AnalystCard />');
    const card = fs.readFileSync('components/setup/AnalystCard.tsx', 'utf8');
    expect(card).toContain('data-testid="analyst-gaps"');
    expect(card).toContain('/api/analyst/verify');
    expect(card).toContain('USD');
  });
});
