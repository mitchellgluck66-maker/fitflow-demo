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
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const countOk = { beta: { messages: { countTokens: async () => ({ input_tokens: 24_000 }), create: async () => ({ stop_reason: 'max_tokens', usage: { input_tokens: 24_000, output_tokens: 64 } }) } } } as unknown as Anthropic;
const countReject = {
  beta: {
    messages: {
      countTokens: async () => {
        throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: "tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string', 'null']'" }, request_id: 'req_x' }, '400', new Headers());
      },
      create: async () => {
        throw new Error('must not be called after count_tokens rejected the schemas');
      },
    },
  },
} as unknown as Anthropic;

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
    const ok = await verifyAnalystConnection({ client: scripted([m([{ type: 'tool_use', id: 't1', name: 'get_notes', input: {} }], 'tool_use'), m([{ type: 'text', text: good }])]), countClient: countOk });
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/^Connected · schema budget ok · 15\/20 strict tools · 0\/24 optional · 0\/16 unions · schemas accepted by messages.create \(24,000 prompt tokens\) · verified with a streamed tool call · claude-opus-5-5 · get_notes · /);
    const noTool = await verifyAnalystConnection({ client: scripted([m([{ type: 'text', text: good }])]), countClient: countOk });
    expect(noTool).toMatchObject({ ok: false, message: 'Verification failed: the model answered without calling a tool (tool_choice auto did not produce a call)' });
    const refused = await verifyAnalystConnection({ client: scripted([m([], 'refusal')]), countClient: countOk });
    expect(refused.message).toBe('Verification failed: Claude declined the request.');
  });
  it('a schema the API rejects fails Verify FIRST, with the exact API message, before any paid request', async () => {
    let paid = 0;
    const client = scripted([]);
    const origStream = client.beta.messages.stream;
    client.beta.messages.stream = (p) => {
      paid += 1;
      return origStream(p);
    };
    const r = await verifyAnalystConnection({ client, countClient: countReject });
    expect(r).toMatchObject({ ok: false, message: "Verification failed: schema budget ok · 15/20 strict tools · 0/24 optional · 0/16 unions · count_tokens rejected the schemas: Anthropic 400 · invalid_request_error: tools.1.custom: Invalid schema: Enum value 'today' does not match declared type '['string', 'null']' (request_id req_x)" });
    expect(paid).toBe(0);
  });
  it('the Setup page mounts the Analyst card, which shows the gaps checklist and the answer-mode setting', () => {
    expect(fs.readFileSync('app/setup/page.tsx', 'utf8')).toContain('<AnalystCard />');
    const card = fs.readFileSync('components/setup/AnalystCard.tsx', 'utf8');
    expect(card).toContain('data-testid="analyst-gaps"');
    expect(card).toContain('/api/analyst/verify');
    expect(card).toContain('USD');
  });
});
