/**
 * The live schema check (2026-09-30, three 400s): it measures with real messages.create calls on the exact
 * production prompt — the answer schema alone, the production request (answer strict + 15 non-strict
 * tools), count_tokens as a secondary, and the informational strict-capacity bisection — and reports the
 * API's exact message and the cost per step.
 */
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { checkAnalystSchemasLive, formatSchemaLine, productionRequestForBudget } from '@/lib/analyst/schemaCheck';
import { ANALYST_TOOL_DEFINITIONS } from '@/lib/analyst/tools';
import { ANALYST_CONTRACT } from '@/lib/analyst/prompts';
import { ANSWER_SCHEMA } from '@/lib/analyst/schema';
import { SUBMIT_ANSWER_TOOL } from '@/lib/analyst/api';

const reject = (message: string) => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message }, request_id: 'req_011CfabA6pwwMHPLkDFCdshj' }, '400', new Headers());

/** A fake API that accepts a request only when at most `maxStrict` strict tools accompany the answer. */
function fake(maxStrict: number) {
  const created: Array<Record<string, unknown>> = [];
  const counted: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        countTokens: async (p: Record<string, unknown>) => (counted.push(p), { input_tokens: 21_340 }),
        create: async (p: Record<string, unknown>) => {
          created.push(p);
          const strict = ((p.tools ?? []) as Array<{ strict?: boolean }>).filter((t) => t.strict).length;
          if (strict > maxStrict) throw reject('The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.');
          return { stop_reason: 'max_tokens', usage: { input_tokens: 21_400, output_tokens: 64 } };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, created, counted };
}

describe('checkAnalystSchemasLive', () => {
  it('full scope: static → count_tokens → answer alone → production → strict capacity, each with cost; the production request is answer-strict + 15 non-strict tools', async () => {
    const f = fake(6);
    const lines = await checkAnalystSchemasLive({ key: 'k', brief: 'THE BRIEF', models: ['claude-opus-5-5'], scope: 'full', client: f.client });
    expect(lines.map((l) => [l.step, l.ok])).toEqual([['count_tokens', true], ['answer_alone', true], ['production', true], ['strict_capacity', true]]);
    expect(formatSchemaLine(lines[0])).toBe('PASS count_tokens · claude-opus-5-5 · schema budget ok · 0/20 strict tools · 0/24 optional · 0/16 unions · count_tokens accepted the production prompt · 21,340 input tokens (secondary — it does not compile grammars)');
    expect(formatSchemaLine(lines[1])).toBe('PASS answer_alone · claude-opus-5-5 · answer schema alone (output_config.format, no tools) · accepted (stop max_tokens) · $0.09 USD');
    expect(formatSchemaLine(lines[2])).toBe('PASS production · claude-opus-5-5 · schema budget ok · 0/20 strict tools · 0/24 optional · 0/16 unions · the production request (answer schema strict + 15 non-strict tools) · accepted (stop max_tokens) · $0.09 USD');
    expect(lines[3].message).toMatch(/^informational: 6 of 15 tools can be strict alongside the answer \(binary search 8:rejected, 4:ok, 6:ok, 7:rejected\) · \$0\.17 USD$/); // only the accepted requests are billed
    // The requests: answer alone has no tools; production has the 15 tools, none strict, the answer as output_config.format.
    const alone = f.created[0] as { tools: unknown[]; output_config: { format: { schema: unknown } } };
    expect(alone.tools).toEqual([]);
    expect(alone.output_config.format.schema).toEqual(ANSWER_SCHEMA);
    const prod = f.created[1] as { tools: Array<{ name: string; strict?: boolean }>; system: Array<{ text: string }>; max_tokens: number; tool_choice: unknown };
    expect(prod.tools.map((t) => t.name)).toEqual(ANALYST_TOOL_DEFINITIONS.map((t) => t.name));
    expect(prod.tools.every((t) => t.strict === false)).toBe(true);
    expect(prod.system.map((s) => s.text)).toEqual([ANALYST_CONTRACT, 'THE BRIEF']);
    expect(prod.max_tokens).toBe(64);
    expect(prod.tool_choice).toEqual({ type: 'auto' });
    expect(f.counted.length).toBe(1);
    expect(productionRequestForBudget('submit_answer').tools.find((t) => t.name === SUBMIT_ANSWER_TOOL)?.strict).toBe(true);
  });
  it('a rejected production request names the step and the exact API message; the answer alone can still pass', async () => {
    const f = fake(-1); // any request with tools... no: reject when strict > -1 → every create fails, including answer alone
    const lines = await checkAnalystSchemasLive({ key: 'k', brief: 'b', models: ['claude-fable-5-1'], scope: 'probe', client: f.client });
    expect(lines.map((l) => [l.step, l.ok])).toEqual([['answer_alone', false], ['production', false]]);
    expect(formatSchemaLine(lines[1])).toBe('FAIL production · claude-fable-5-1 · schema budget ok · 0/20 strict tools · 0/24 optional · 0/16 unions · the production request (answer schema strict + 15 non-strict tools) · REJECTED: Anthropic 400 · invalid_request_error: The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools. (request_id req_011CfabA6pwwMHPLkDFCdshj)');
  });
  it('verify scope: static, count_tokens and the production request only (no capacity search, no spend beyond one request)', async () => {
    const f = fake(0);
    const lines = await checkAnalystSchemasLive({ key: 'k', brief: 'b', models: ['claude-opus-5-5'], scope: 'verify', client: f.client });
    expect(lines.map((l) => l.step)).toEqual(['count_tokens', 'production']);
    expect(f.created.length).toBe(1);
  });
});
