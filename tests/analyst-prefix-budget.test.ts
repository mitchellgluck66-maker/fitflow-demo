/**
 * The cold prefix budget (Oct 7 item 5): the contract + brief + tools + the starter snapshot on the demo tenant
 * stay under PREFIX_BUDGET_TOKENS (chars ÷ 3.6), so growth fails the build before a smoke pays for it; the
 * measurement differences four count_tokens calls; the line names the largest piece when over.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { rebuildBrief, currentBrief } from '@/lib/analyst/briefService';
import { ANALYST_CONTRACT } from '@/lib/analyst/prompts';
import { ANALYST_TOOL_DEFINITIONS, ANALYST_TOOLS } from '@/lib/analyst/tools';
import { runStarterCalls, starterMessages, starterRows } from '@/lib/analyst/starter';
import { approxPrefix, formatPrefixLine, measurePrefix, overBudget, PREFIX_BUDGET_TOKENS, type PrefixParts } from '@/lib/analyst/prefixBudget';
import { buildCountRequest } from '@/lib/analyst/api';

describe('prefix budget', () => {
  let parts: PrefixParts;
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
    await rebuildBrief({ trigger: 'manual', countTokens: false });
    const brief = (await currentBrief())!;
    const results = await runStarterCalls({ stale: false, line: 'data fresh — test', phrase: 'data fresh', oldestAgeMinutes: 30, sources: [] }, ANALYST_TOOLS);
    parts = { contract: ANALYST_CONTRACT, brief: brief.text, tools: ANALYST_TOOL_DEFINITIONS, messages: starterMessages(starterRows('t', 'How did last week go?', 'How did last week go?', results)) };
  }, 120_000);

  it(`the demo tenant's cold prefix is under ${PREFIX_BUDGET_TOKENS} tokens (≈ chars ÷ 3.6), each piece named`, () => {
    const p = approxPrefix(parts);
    console.log(formatPrefixLine(p));
    expect(overBudget(p), formatPrefixLine(p)).toBeNull();
    expect(p.total).toBeLessThanOrEqual(PREFIX_BUDGET_TOKENS);
    expect(p.brief).toBeLessThan(8_000); // the glossary is one line per entry now (it was half the brief)
    expect(p.snapshot).toBeLessThan(7_000); // r1 + r2 with compact indexes
    expect(formatPrefixLine(p)).toMatch(/^prefix: contract [\d.]+K · brief [\d.]+K · tools [\d.]+K · snapshot [\d.]+K · total [\d.]+K \(≈ chars ÷ 3\.6\) — budget 40\.0K$/);
  });

  it('measurePrefix differences four counts (contract · +brief · +tools · +messages) and names the largest piece when over budget', async () => {
    const seen: Array<ReturnType<typeof buildCountRequest>> = [];
    const sizes = [2_000, 8_000, 13_000, 19_000];
    const p = await measurePrefix('claude-opus-5-5', parts, async (params) => { seen.push(params); return sizes[seen.length - 1]; });
    expect(p).toEqual({ contract: 2_000, brief: 6_000, tools: 5_000, snapshot: 6_000, total: 19_000, measured: true });
    expect(seen[0].system).toHaveLength(1); // the contract alone: an empty brief block is skipped, never sent empty
    expect(seen[1].system).toHaveLength(2);
    expect(seen[2].tools).toHaveLength(ANALYST_TOOL_DEFINITIONS.length);
    expect(seen[3].messages).toEqual(parts.messages);
    expect(formatPrefixLine(p)).toBe('prefix: contract 2.0K · brief 6.0K · tools 5.0K · snapshot 6.0K · total 19.0K (count_tokens) — budget 40.0K');
    const over = { ...p, brief: 30_000, total: 47_000 };
    expect(overBudget(over)).toBe('prefix 47.0K tokens > 40.0K budget — largest piece: brief 30.0K');
    expect(formatPrefixLine(over)).toContain('— OVER the 40.0K budget');
  });
});
