/**
 * Thin wrapper over the official SDK. Every call asks for STRUCTURED output
 * via a forced tool call with a strict input_schema, then validates the
 * result with Zod — Claude never free-texts JSON at us. The key never
 * appears in any error we record.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getAnthropicConfig } from './config';
import { toStrictToolSchema } from './strictSchema';

export { toStrictToolSchema } from './strictSchema';

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
          // Strict mode rejects maxItems / minimum / maxLength …: send only the sanitized schema (limits move into
          // descriptions; the Zod `schema` below still enforces them on the answer).
          input_schema: toStrictToolSchema(params.inputSchema) as Anthropic.Tool['input_schema'],
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
      const issue = parsed.error.issues[0];
      return { ok: false, data: null, usage: null, error: `Answer failed validation at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`, model: config.model };
    }
    return {
      ok: true,
      data: parsed.data,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: config.model,
    };
  } catch (err) {
    return { ok: false, data: null, usage: null, error: scrub(describeError(err), config.key), model: config.model };
  }
}

/** "Anthropic 400: <message> (request_id req_…)" — the id is what Anthropic support needs. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const id = err.requestID;
    const base = `Anthropic ${err.status ?? 'error'}: ${err.message}`;
    return id && !base.includes(id) ? `${base} (request_id ${id})` : base;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Setup → Anthropic "Verify": the SAME call path every feature uses — askClaude with a strict tool whose
 * schema carries a limit the sanitizer must move (maxLength). A plain ping said "Connected" for a key that
 * could not run a single feature (2026-09-30), so "Connected" now means a structured call succeeded.
 */
export const VERIFY_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'note'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    note: { type: 'string', maxLength: 40, description: 'Two or three words.' },
  },
} as const;

export async function testConnection(): Promise<{ ok: boolean; configured: boolean; message: string; model?: string }> {
  const config = await getAnthropicConfig();
  if (!config.configured || !config.key) return { ok: false, configured: false, message: 'No Anthropic API key set.' };
  const res = await askClaude({
    system: 'You are a connectivity check. Call the tool with status "ok".',
    user: 'Confirm the connection.',
    inputSchema: VERIFY_TOOL_SCHEMA as unknown as Record<string, unknown>,
    schema: z.object({ status: z.literal('ok'), note: z.string() }),
    toolName: 'submit_check',
    maxTokens: 64,
  });
  if (!res.ok) return { ok: false, configured: true, message: `Verification failed: ${res.error ?? 'no structured answer'}`, model: config.model };
  return { ok: true, configured: true, message: `Connected · verified with a structured call · ${res.model ?? config.model}`, model: res.model ?? config.model };
}
