/**
 * Thin wrapper over the official SDK. Every call asks for STRUCTURED output
 * via a forced tool call with a strict input_schema, then validates the
 * result with Zod — Claude never free-texts JSON at us. The key never
 * appears in any error we record.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { getAnthropicConfig } from './config';

export interface AskResult<T> {
  ok: boolean;
  data: T | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error?: string;
  notConfigured?: boolean;
  model: string | null;
}

function scrub(text: string, key: string | null): string {
  return key ? text.split(key).join('[redacted]') : text;
}

function makeClient(key: string): Anthropic {
  // Passing globalThis.fetch explicitly means tests can stub it.
  return new Anthropic({ apiKey: key, maxRetries: 1, fetch: globalThis.fetch, timeout: 60_000 });
}

export async function askClaude<T>(params: {
  system: string;
  user: string;
  /** JSON schema for the forced tool's input — the structured answer. */
  inputSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  toolName?: string;
  maxTokens?: number;
}): Promise<AskResult<T>> {
  const config = await getAnthropicConfig();
  if (!config.configured || !config.key) {
    return { ok: false, data: null, usage: null, notConfigured: true, error: 'Anthropic API key not configured.', model: null };
  }
  const toolName = params.toolName ?? 'submit';
  try {
    const client = makeClient(config.key);
    const response = await client.messages.create({
      model: config.model,
      max_tokens: params.maxTokens ?? 2048,
      system: params.system,
      messages: [{ role: 'user', content: params.user }],
      tools: [
        {
          name: toolName,
          description: 'Submit the structured answer.',
          input_schema: params.inputSchema as Anthropic.Tool['input_schema'],
          strict: true,
        },
      ],
      tool_choice: { type: 'tool', name: toolName },
    });

    if (response.stop_reason === 'refusal') {
      return { ok: false, data: null, usage: null, error: 'Claude declined the request.', model: config.model };
    }
    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) {
      return { ok: false, data: null, usage: null, error: 'No structured answer returned.', model: config.model };
    }
    const parsed = params.schema.safeParse(block.input);
    if (!parsed.success) {
      return { ok: false, data: null, usage: null, error: `Answer failed validation: ${parsed.error.issues[0]?.message}`, model: config.model };
    }
    return {
      ok: true,
      data: parsed.data,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: config.model,
    };
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? `Anthropic ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, data: null, usage: null, error: scrub(message, config.key), model: config.model };
  }
}

/** One tiny request to prove the key works. */
export async function testConnection(): Promise<{ ok: boolean; configured: boolean; message: string; model?: string }> {
  const config = await getAnthropicConfig();
  if (!config.configured || !config.key) return { ok: false, configured: false, message: 'No Anthropic API key set.' };
  try {
    const client = makeClient(config.key);
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    return { ok: true, configured: true, message: `Connected (${res.model}).`, model: res.model };
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? `Anthropic ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, configured: true, message: scrub(message, config.key) };
  }
}
