/**
 * The smoke runner (npm run smoke:anthropic) with the Messages API stubbed:
 * one line per feature, the narrative is a DRY RUN (never stored — Monday's
 * digest reuses a stored paragraph), ask + insight rows persist, an unusable
 * key is a FAIL with the exact reason, and "nothing exercised" is SKIP.
 * The LIVE proof is the script itself, run by Mitchell against the real API.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, aiReports, pipelines, stages, contacts, settings } from '@/db';
import { setSetting } from '@/lib/settings';
import { ANTHROPIC_KEYS } from '@/lib/anthropic/config';
import { runAnthropicSmoke, formatSmokeLine, keyProblem } from '@/lib/anthropic/smoke';
import { runWeeklyNarrative } from '@/lib/anthropic/narrative';

const INPUT_BY_TOOL: Record<string, unknown> = {
  submit_answer: { answer: 'Blended CAC divides spend by all enrollments; Paid CAC only by paid ones.', citations: [] },
  submit_findings: { findings: [] },
  submit_paragraph: { paragraph: 'One applicant last week; nothing else moved.' },
  submit_role: { role: 'applied', confidence: 0.95, rationale: 'The first stage of the application pipeline.' },
};

const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const name = body.tools[0].name as string;
  return new Response(
    JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name, input: INPUT_BY_TOOL[name] }], usage: { input_tokens: 120, output_tokens: 30 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});

beforeAll(async () => {
  await runMigrations();
  vi.stubGlobal('fetch', fetchSpy);
  const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
  await db.insert(pipelines).values({ id: 'p-smoke', name: '[new] Application Pipeline', isTracked: true, ...prov });
  await db.insert(stages).values({ id: 's-smoke', pipelineId: 'p-smoke', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov });
  // An applicant 7 days ago always lands in last Sun–Sat week → the weekly narrative has something to say.
  await db.insert(contacts).values({ ghlContactId: 'c-smoke', pipelineId: 'p-smoke', stageId: 's-smoke', firstName: 'Sam', email: 'sam@x.com', ghlCreatedAt: new Date(Date.now() - 7 * 86_400_000), ...prov });
});
afterAll(() => vi.unstubAllGlobals());

describe('smoke:anthropic runner', () => {
  it('no key → one FAIL naming exactly why, and no API call', async () => {
    const { lines, ok } = await runAnthropicSmoke();
    expect(ok).toBe(false);
    expect(lines.map(formatSmokeLine)).toEqual(['FAIL config · Anthropic not configured — no stored key and no ANTHROPIC_API_KEY']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an encrypted key without CREDENTIALS_KEY here → FAIL that says to add it', async () => {
    await db.insert(settings).values({ key: ANTHROPIC_KEYS.apiKey, value: 'enc:v1:aaaa:bbbb:cccc', isSecret: true }).onConflictDoUpdate({ target: settings.key, set: { value: 'enc:v1:aaaa:bbbb:cccc', isSecret: true } });
    expect(await keyProblem()).toMatch(/CREDENTIALS_KEY is not set here/);
  });

  it('4 × PASS with model + tokens; ask and insight rows persist; the narrative is NOT stored', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-smoke-test-0000', { secret: true });
    const { lines, ok } = await runAnthropicSmoke();
    const out = lines.map(formatSmokeLine);
    expect(ok, out.join('\n')).toBe(true);
    expect(out).toHaveLength(4);
    expect(out[0]).toMatch(/^PASS ask · claude-sonnet-5 · 120\/30 tokens · Blended CAC divides/);
    expect(out[1]).toMatch(/^PASS insights · claude-sonnet-5 · 120\/30 tokens · 0 finding\(s\)/);
    expect(out[2]).toMatch(/^PASS narrative · claude-sonnet-5 · 120\/30 tokens · dry run, not stored · One applicant/);
    expect(out[3]).toMatch(/^PASS remap · .* "Applied" → applied \(0\.95\)/);
    expect(out.join('\n')).not.toContain('sk-ant-smoke-test-0000');

    const rows = await db.select({ kind: aiReports.kind }).from(aiReports);
    expect(rows.map((r) => r.kind).sort()).toEqual(['ask', 'insight']);
    expect(await db.select().from(aiReports).where(eq(aiReports.kind, 'weekly_narrative'))).toHaveLength(0);
  });

  it('dryRun never writes, a normal forced run does', async () => {
    const dry = await runWeeklyNarrative('weekly', { force: true, dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true, paragraph: 'One applicant last week; nothing else moved.' });
    expect(await db.select().from(aiReports).where(eq(aiReports.kind, 'weekly_narrative'))).toHaveLength(0);
    await runWeeklyNarrative('weekly', { force: true });
    expect(await db.select().from(aiReports).where(eq(aiReports.kind, 'weekly_narrative'))).toHaveLength(1);
  });
});
