/**
 * CLAUDE.md rule 1: no code path can send a non-GET request to GoHighLevel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS, ENABLE_WRITEBACK } from '@/lib/ghl/config';
import { ghlRequest, GhlReadOnlyViolation } from '@/lib/ghl/client';

describe('GoHighLevel read-only guard', () => {
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    await runMigrations();
    await setSetting(CREDENTIAL_KEYS.token, 'pit-test-token', { secret: true });
    await setSetting(CREDENTIAL_KEYS.locationId, 'loc_test');
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ENABLE_WRITEBACK is hard-off', () => {
    expect(ENABLE_WRITEBACK).toBe(false);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'] as const)('throws on %s before any network I/O', async (method) => {
    await expect(
      ghlRequest({ method, endpoint: '/contacts/abc/tags', family: 'contacts', body: { tags: ['x'] } }),
    ).rejects.toBeInstanceOf(GhlReadOnlyViolation);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows GET and sends the right Version header per family', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ pipelines: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await ghlRequest({ method: 'GET', endpoint: '/opportunities/pipelines', family: 'opportunities' });
    expect(res.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('https://services.leadconnectorhq.com/opportunities/pipelines')).toBe(true);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Version).toBe('2021-07-28');

    await ghlRequest({ method: 'GET', endpoint: '/calendars/', family: 'calendars' });
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((init2.headers as Record<string, string>).Version).toBe('v3');
  });

  it('never puts the token in an error message', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const res = await ghlRequest({ method: 'GET', endpoint: '/calendars/', family: 'calendars' });
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain('pit-test-token');
  });
});
