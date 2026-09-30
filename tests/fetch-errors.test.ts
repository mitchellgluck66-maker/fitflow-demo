/**
 * Audit P1 #1 (2026-09-30): a client-side fetch that fails, hangs or gets a non-2xx must render a visible
 * error with Retry — never "Failed to fetch" swallowed into an endless skeleton — and an API route whose
 * query never answers must return a 504 JSON, never hang until the platform kills it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { fetchJson, describeFetchFailure, FetchJsonError } from '@/lib/clientFetch';
import { dbTimeout, DbTimeoutError, apiErrorResponse } from '@/lib/dbTimeout';
import { FetchError } from '@/components/FetchError';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchJson: every failure is a sentence', () => {
  it('a network failure ("Failed to fetch") names the path and the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchJson('/api/clients?limit=50')).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining("Could not reach FitFlow's server for /api/clients") });
  });

  it('a non-2xx status surfaces the API\'s own error and detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'The database did not answer within 30 s (list clients) — the connection was reset; try again', timeout: true }), { status: 504 })));
    const err = (await fetchJson('/api/clients').catch((e) => e)) as FetchJsonError;
    expect(err).toBeInstanceOf(FetchJsonError);
    expect(err).toMatchObject({ kind: 'http', status: 504 });
    expect(err.message).toMatch(/did not answer within 30 s/);
  });

  it('a route that never answers is given up on after the timeout, with a sentence', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    const p = fetchJson('/api/currency', {}, { timeoutMs: 1000 }).catch((e) => e as FetchJsonError);
    await vi.advanceTimersByTimeAsync(1001);
    const err = await p;
    expect(err).toMatchObject({ kind: 'timeout', message: '/api/currency did not answer within 1 s.' });
  });

  it('describeFetchFailure never returns the bare "Failed to fetch"', () => {
    expect(describeFetchFailure(new TypeError('Failed to fetch'), '/api/settings').message).not.toBe('Failed to fetch');
  });
});

describe('FetchError renders the error state with Retry', () => {
  it('shows the title, the sentence and a Retry button', () => {
    const html = renderToStaticMarkup(React.createElement(FetchError, { title: 'Could not load clients', error: "Could not reach FitFlow's server for /api/clients — the request failed before a response arrived (offline, or the server did not answer).", onRetry: () => undefined }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load clients');
    expect(html).toContain('Could not reach FitFlow');
    expect(html).toContain('Retry');
  });
});

describe('dbTimeout: a query that never answers becomes a 504, not a 300 s hang', () => {
  it('rejects with DbTimeoutError after the budget and apiErrorResponse maps it to 504', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const p = dbTimeout(never, 'list clients', 500).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(501);
    const err = await p;
    expect(err).toBeInstanceOf(DbTimeoutError);
    expect(err.message).toBe('The database did not answer within 1 s (list clients) — the connection was reset; try again');
    const res = apiErrorResponse(err, 'Failed to list clients');
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ timeout: true });
  });

  it('a fast query passes through untouched; a RangeError is the caller\'s 400; anything else is a 500 with detail', async () => {
    expect(await dbTimeout(Promise.resolve(42), 'x', 100)).toBe(42);
    expect(apiErrorResponse(new RangeError('from must be YYYY-MM-DD'), 'f').status).toBe(400);
    const r = apiErrorResponse(new Error('boom'), 'Failed to list clients');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'Failed to list clients', detail: 'boom' });
    // drizzle's wrapper: the driver's cause is the detail, never the query text
    const wrapped = Object.assign(new Error('Failed query: select "contacts"."id" … params: 50,0'), { cause: new Error('write CONNECT_TIMEOUT 10.255.255.1:5432') });
    expect((await apiErrorResponse(wrapped, 'Failed to list clients').json()).detail).toBe('write CONNECT_TIMEOUT 10.255.255.1:5432');
  });

  it('GET /api/clients answers 504 JSON when the query hangs', async () => {
    vi.useFakeTimers();
    vi.doMock('@/lib/queries/clients', () => ({ listClients: () => new Promise(() => undefined) }));
    const { GET } = await import('@/app/api/clients/route');
    const p = GET(new NextRequest('http://localhost/api/clients?limit=50'));
    await vi.advanceTimersByTimeAsync(30_001);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/did not answer within 30 s \(list clients\)/);
    vi.doUnmock('@/lib/queries/clients');
  });
});

// Audit P2 #10 (2026-09-30): stale copy. Digests send on the first hourly run at/after 6am local (lib/email/cron), not "7am".
describe('P2 #10: the UI copy matches the send window', () => {
  it('no page says "7am", "Phase C", "once Anthropic is connected" or "Sales Onboarding"', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));
    const offenders: string[] = [];
    for (const f of [...walk('app'), ...walk('components')]) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      for (const bad of ['7am', 'Phase C', 'once Anthropic is connected', 'Sales Onboarding']) if (src.includes(bad)) offenders.push(`${f}: ${bad}`);
    }
    expect(offenders).toEqual([]);
  });
});

// Audit P2 #12 (2026-09-30): "Consults booked 49 / Enrollments 20" (in period) beside a strip saying "43 / 16" (cohort).
describe('P2 #12: the Command Center says which mode each number is in', () => {
  it('the in-period tiles and the cohort strip carry a visible qualifier', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/page.tsx', 'utf8');
    expect(src).toContain('subtext={`in period · ${marketing.paidEnrollments} paid');
    expect(src).toContain('subtext={`in period · ${scorecard.kpis.applied.current ?? 0} applied`}');
    expect(src).toContain('a cohort, so it differs from the in-period tiles above');
  });
});
