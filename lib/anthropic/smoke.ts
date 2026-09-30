/**
 * Live smoke test for the AI features (Definition of done §3, 2026-09-30):
 * exercises each feature through its REAL function with the stored key and
 * reports one line per feature. `npm run smoke:anthropic` is the CLI.
 *
 *   ask        askDashboard — persists one `ask` row (acceptance evidence)
 *   insights   runInsights({force}) — persists one `insight` row
 *   narrative  runWeeklyNarrative dry run — validated, NEVER stored (Monday's
 *              digest reuses the stored paragraph for the period)
 *   remap      suggestStage on a real followed-pipeline stage — writes nothing
 *
 * Never prints the key. A line is PASS, FAIL (exact error + request_id) or
 * SKIP (nothing was exercised — counted as not verified, never as PASS).
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, settings, stages, pipelines } from '@/db';
import { keyStatus, isEncrypted, openSecret } from '../crypto/credentials';
import { askDashboard } from './ask';
import { runInsights } from './insights';
import { runWeeklyNarrative } from './narrative';
import { suggestRoleForStage } from './remap';
import { getAnthropicConfig, ANTHROPIC_KEYS } from './config';

export type SmokeStatus = 'PASS' | 'FAIL' | 'SKIP';
export interface SmokeLine {
  feature: 'config' | 'ask' | 'insights' | 'narrative' | 'remap';
  status: SmokeStatus;
  text: string;
}

const first80 = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
const tokens = (u: { inputTokens: number; outputTokens: number } | null | undefined) => (u ? `${u.inputTokens}/${u.outputTokens} tokens` : 'tokens n/a');

/** Why the configured key cannot be used, or null when it can. Reads the raw row so the reason is exact. */
export async function keyProblem(): Promise<string | null> {
  const config = await getAnthropicConfig();
  if (config.configured) return null;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, ANTHROPIC_KEYS.apiKey)).limit(1);
  if (row?.value && isEncrypted(row.value)) {
    const status = keyStatus();
    if (status.mode !== 'on') return 'a key is stored encrypted but CREDENTIALS_KEY is not set here — add it to .env.local (same value as Vercel) or set ANTHROPIC_API_KEY';
    if (openSecret(row.value, status) === null) return 'the stored key cannot be decrypted with this CREDENTIALS_KEY (wrong key?)';
  }
  return 'Anthropic not configured — no stored key and no ANTHROPIC_API_KEY';
}

export async function runAnthropicSmoke(): Promise<{ lines: SmokeLine[]; ok: boolean }> {
  const lines: SmokeLine[] = [];
  const problem = await keyProblem();
  if (problem) {
    lines.push({ feature: 'config', status: 'FAIL', text: problem });
    return { lines, ok: false };
  }
  const config = await getAnthropicConfig();

  const ask = await askDashboard({ question: 'Why is Paid CAC different from Blended CAC?' });
  lines.push(ask.ok
    ? { feature: 'ask', status: 'PASS', text: `${ask.model ?? config.model} · ${tokens(ask.usage)} · ${first80(ask.answer)}` }
    : { feature: 'ask', status: 'FAIL', text: ask.error ?? 'no answer and no error text' });

  const insights = await runInsights({ force: true });
  lines.push(insights.ok
    ? { feature: 'insights', status: 'PASS', text: `${insights.model ?? config.model} · ${tokens(insights.usage)} · ${insights.findings.length} finding(s) · ${first80(insights.findings[0]?.title ?? '(no notable findings)')}` }
    : { feature: 'insights', status: 'FAIL', text: insights.error ?? 'failed with no error text' });

  const narrative = await runWeeklyNarrative('weekly', { force: true, dryRun: true });
  if (narrative.ok && narrative.paragraph) {
    lines.push({ feature: 'narrative', status: 'PASS', text: `${narrative.model ?? config.model} · ${tokens(narrative.usage)} · dry run, not stored · ${first80(narrative.paragraph)}` });
  } else if (narrative.ok && narrative.error === 'empty period') {
    lines.push({ feature: 'narrative', status: 'SKIP', text: `last week (${narrative.periodStart}–${narrative.periodEnd}) is empty — no call made, NOT verified` });
  } else {
    lines.push({ feature: 'narrative', status: 'FAIL', text: narrative.error ?? 'no paragraph and no error text' });
  }

  const [stage] = await db
    .select({ id: stages.id, name: stages.name })
    .from(stages)
    .innerJoin(pipelines, eq(pipelines.id, stages.pipelineId))
    .where(and(eq(pipelines.isTracked, true)))
    .orderBy(asc(stages.position))
    .limit(1);
  if (!stage) {
    lines.push({ feature: 'remap', status: 'SKIP', text: 'no stage in a followed pipeline to test with — NOT verified' });
  } else {
    const remap = await suggestRoleForStage(stage.id);
    lines.push(remap.ok
      ? { feature: 'remap', status: 'PASS', text: `${remap.model ?? config.model} · ${tokens(remap.usage)} · "${stage.name}" → ${remap.role} (${remap.confidence}) · ${first80(remap.rationale)}` }
      : { feature: 'remap', status: 'FAIL', text: remap.error ?? 'failed with no error text' });
  }

  return { lines, ok: lines.every((l) => l.status === 'PASS') };
}

export function formatSmokeLine(l: SmokeLine): string {
  return `${l.status} ${l.feature} · ${l.text}`;
}
