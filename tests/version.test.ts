import { describe, it, expect } from 'vitest';
import { versionInfo } from '@/lib/version';
import { GET } from '@/app/api/version/route';

describe('GET /api/version (2026-10-15) — confirms which build is serving', () => {
  it('reports Vercel\'s commit SHA and the build stamp', () => {
    expect(versionInfo({ VERCEL_GIT_COMMIT_SHA: 'abc123 ', BUILT_AT: '2026-10-15T13:00:00.000Z' })).toEqual({ commit: 'abc123', builtAt: '2026-10-15T13:00:00.000Z' });
  });
  it('is null, never a made-up value, outside a Vercel build', () => {
    expect(versionInfo({})).toEqual({ commit: null, builtAt: null });
    expect(versionInfo({ VERCEL_GIT_COMMIT_SHA: '', BUILT_AT: '  ' })).toEqual({ commit: null, builtAt: null });
  });
  it('the route answers JSON with no-store', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['builtAt', 'commit']);
  });
});
