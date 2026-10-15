/**
 * 2026-10-15: the Insights card + nightly generator are paused behind INSIGHTS_ENABLED (default off) until rebuilt
 * on the Analyst's safeguards. Paused = the API says so, the dispatch step is `skipped` with the reason, the
 * generator is never called.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { insightsEnabled, insightsSkipReason, INSIGHTS_PAUSED_REASON, INSIGHTS_PAUSED_TEXT } from '@/lib/anthropic/insightsFlag';
import { runDispatch } from '@/lib/dispatch';

beforeAll(async () => {
  await runMigrations();
});
afterEach(() => vi.unstubAllEnvs());

describe('Insights flag', () => {
  it('is off unless INSIGHTS_ENABLED is 1 / true / on', () => {
    expect(insightsEnabled({})).toBe(false);
    expect(insightsEnabled({ INSIGHTS_ENABLED: 'false' })).toBe(false);
    expect(insightsEnabled({ INSIGHTS_ENABLED: 'yes' })).toBe(false);
    for (const v of ['1', 'true', 'TRUE', 'on', ' on ']) expect(insightsEnabled({ INSIGHTS_ENABLED: v }), v).toBe(true);
    expect(insightsSkipReason({})).toBe(INSIGHTS_PAUSED_REASON);
    expect(insightsSkipReason({ INSIGHTS_ENABLED: 'true' })).toBeNull();
  });

  it('paused: GET answers the one line, POST refuses (409) and the generator is not called', async () => {
    vi.stubEnv('INSIGHTS_ENABLED', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { GET, POST } = await import('@/app/api/anthropic/insights/route');
    const get = await GET(new NextRequest('http://localhost/api/anthropic/insights?range=last_week'));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ paused: true, message: INSIGHTS_PAUSED_TEXT, findings: [], notConfigured: false });
    const post = await POST(new NextRequest('http://localhost/api/anthropic/insights', { method: 'POST', body: JSON.stringify({ force: true }) }));
    expect(post.status).toBe(409);
    expect(await post.json()).toMatchObject({ ok: false, paused: true, reason: INSIGHTS_PAUSED_REASON });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('enabled: GET reads the stored findings as before', async () => {
    vi.stubEnv('INSIGHTS_ENABLED', 'true');
    const { GET } = await import('@/app/api/anthropic/insights/route');
    const get = await GET(new NextRequest('http://localhost/api/anthropic/insights?range=last_week'));
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.paused).toBeUndefined();
    expect(body).toMatchObject({ cached: true, findings: [] });
  });

  it('the dispatch step is skipped with the reason — never succeeded, never run', async () => {
    const calls: string[] = [];
    const recorded: Array<[string, unknown]> = [];
    const result = await runDispatch(
      [{ name: 'insights', skip: insightsSkipReason({}), run: async () => { calls.push('insights'); return { ok: true }; } }],
      { record: async (name, outcome) => { recorded.push([name, outcome]); } },
    );
    expect(calls).toEqual([]);
    expect(result.steps.insights).toEqual({ status: 'skipped', reason: 'paused pending Analyst rebuild' });
    expect(recorded).toEqual([['insights', { status: 'skipped', reason: 'paused pending Analyst rebuild' }]]);
  });
});
