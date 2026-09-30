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
import { noteAnthropicOutcome, type AnthropicSeverity } from './incident';
import { assertRequestBudget } from './schemaBudget';

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
  // Passing globalThis.fetch explicitly means tests can stub it. No SDK retries: askClaude retries a TRANSIENT
  // failure exactly once itself, so it knows whether an error survived the retry (→ warning incident).
  return new Anthropic({ apiKey: key, maxRetries: 0, fetch: globalThis.fetch, timeout: 60_000 });
}

/** Pause before the single retry of a transient failure. */
export const RETRY_DELAY_MS = 1500;

/** 429 / 529 overloaded / other 5xx / 408 / 409 / network: worth one retry, then a WARNING. Everything else is permanent. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
    return status === 408 || status === 409 || status === 429 || status >= 500 || type === 'overloaded_error' || type === 'rate_limit_error';
  }
  return false;
}

export async function askClaude<T>(params: {
  system: string;
  user: string;
  /** JSON schema for the forced tool's input — the structured answer. */
  inputSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  toolName?: string;
  maxTokens?: number;
  /** Test hook: delay before the one transient retry (default RETRY_DELAY_MS). */
  retryDelayMs?: number;
}): Promise<AskResult<T>> {
  const config = await getAnthropicConfig();
  if (!config.configured || !config.key) {
    return { ok: false, data: null, usage: null, notConfigured: true, error: 'Anthropic API key not configured.', model: null };
  }
  const toolName = params.toolName ?? 'submit';
  // Every outcome below reaches the anthropic_error incident: a failure opens / refreshes it, a success resolves it.
  const fail = async (error: string, severity: AnthropicSeverity): Promise<AskResult<T>> => {
    await noteAnthropicOutcome({ ok: false, error, severity, feature: toolName });
    return { ok: false, data: null, usage: null, error, model: config.model };
  };
  try {
    const client = makeClient(config.key);
    const strictTool = { name: toolName, strict: true, input_schema: toStrictToolSchema(params.inputSchema) };
    // The per-request schema budget (lib/anthropic/schemaBudget.ts) — refused here, never a 400 at the user's question.
    assertRequestBudget({ tools: [strictTool] });
    const request = () =>
      client.messages.create({
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
    let response: Anthropic.Message;
    try {
      response = await request();
    } catch (err) {
      if (!isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, params.retryDelayMs ?? RETRY_DELAY_MS));
      response = await request(); // a second failure is caught below as transient → warning
    }

    if (response.stop_reason === 'refusal') return fail('Claude declined the request.', 'warning');
    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) return fail('No structured answer returned.', 'critical');
    const parsed = params.schema.safeParse(block.input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`Answer failed validation at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`, 'critical');
    }
    await noteAnthropicOutcome({ ok: true });
    return {
      ok: true,
      data: parsed.data,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: config.model,
    };
  } catch (err) {
    return fail(scrub(describeError(err), config.key), isTransientError(err) ? 'warning' : 'critical');
  }
}

/**
 * "Anthropic 400 · invalid_request_error: <message> (request_id req_…)". Reads the API's own error body (the SDK's
 * `err.error`) instead of its raw JSON-in-a-string message; the request id is what Anthropic support needs.
 */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionError) return `Anthropic connection error: ${err.message}`;
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: string; message?: string }; request_id?: string | null } | undefined;
    const detail = body?.error?.message
      ? `${body.error.type ? `${body.error.type}: ` : ''}${body.error.message}`
      : err.message.replace(new RegExp(`^${err.status} `), '');
    const id = err.requestID ?? body?.request_id ?? null;
    return `Anthropic ${err.status ?? 'error'} · ${detail}${id ? ` (request_id ${id})` : ''}`;
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
