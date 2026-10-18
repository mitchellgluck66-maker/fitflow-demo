/**
 * Companion stage 2, item 1 — the write module: the allow-list (three calls pass, every near-miss throws BEFORE
 * any I/O), its own key (the read key is never sent), headers per family, the 429 retry, the token never in an
 * error, dry run sends nothing, and the Verify probe. The read-only client's own guard is unchanged
 * (tests/readonly.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { ghlRequest, GhlReadOnlyViolation } from '@/lib/ghl/client';
import { COMPANION_SETTING_KEYS, dryRunOf, rescheduleAppointmentOf } from '@/lib/companion/config';
import {
  WRITE_ALLOW_LIST,
  assertAllowed,
  companionWrite,
  CompanionWriteRefused,
  updateOpportunity,
  updateAppointmentStatus,
  addContactNote,
  verifyWriteToken,
  hasWriteKey,
  getCompanionWriteConfig,
  setCompanionWriteTransport,
  NO_WRITE_KEY_MESSAGE,
} from '@/lib/companion/ghlWrite';

const READ_TOKEN = 'pit-read-token-0000';
const WRITE_TOKEN = 'pit-write-token-9999';

describe('allow-list (pure)', () => {
  it('is exactly three calls', () => {
    expect(WRITE_ALLOW_LIST.map((a) => `${a.method} ${a.name}`)).toEqual(['PUT update_opportunity', 'PUT update_appointment_status', 'POST add_contact_note']);
  });

  it('accepts the three paths', () => {
    expect(assertAllowed('PUT', '/opportunities/abc123').name).toBe('update_opportunity');
    expect(assertAllowed('PUT', '/calendars/events/appointments/ev_1').name).toBe('update_appointment_status');
    expect(assertAllowed('POST', '/contacts/c-1/notes').name).toBe('add_contact_note');
  });

  it.each([
    ['DELETE', '/opportunities/abc'],
    ['POST', '/opportunities/abc'],
    ['PUT', '/opportunities/abc/status'],
    ['PUT', '/opportunities/'],
    ['PUT', '/opportunities/abc?x=1'],
    ['PUT', '/opportunities/../contacts/abc'],
    ['PUT', '/contacts/abc'],
    ['PUT', '/contacts/abc/notes'],
    ['POST', '/contacts/abc/tags'],
    ['POST', '/contacts/abc/notes/extra'],
    ['DELETE', '/calendars/events/appointments/ev'],
    ['POST', '/calendars/events/appointments'],
    ['GET', '/opportunities/abc'],
    ['PUT', 'opportunities/abc'],
    ['PUT', '/opportunities/abc#frag'],
  ])('refuses %s %s', (method, path) => {
    expect(() => assertAllowed(method, path)).toThrow(CompanionWriteRefused);
  });
});

describe('settings parsers (pure)', () => {
  it('dry run is ON unless the value is exactly "false"; a malformed value is ON and named', () => {
    expect(dryRunOf(null)).toEqual({ on: true, invalidValue: null });
    expect(dryRunOf('true')).toEqual({ on: true, invalidValue: null });
    expect(dryRunOf('false')).toEqual({ on: false, invalidValue: null });
    expect(dryRunOf('off')).toEqual({ on: true, invalidValue: 'off' });
    expect(rescheduleAppointmentOf(null)).toBe('cancelled');
    expect(rescheduleAppointmentOf('leave')).toBe('leave');
    expect(rescheduleAppointmentOf('garbage')).toBe('cancelled');
  });
});

describe('companionWrite (own key, own transport)', () => {
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    await runMigrations();
    await setSetting(CREDENTIAL_KEYS.token, READ_TOKEN, { secret: true });
    await setSetting(CREDENTIAL_KEYS.locationId, 'loc_test');
    await setSetting(COMPANION_SETTING_KEYS.writeToken, WRITE_TOKEN, { secret: true });
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    setCompanionWriteTransport(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCompanionWriteTransport(null);
  });

  it('a refused call throws before any I/O (no fetch, no settings read)', async () => {
    await expect(companionWrite({ method: 'POST', path: '/contacts/abc/tags', body: {} }, { dryRun: false })).rejects.toBeInstanceOf(CompanionWriteRefused);
    await expect(companionWrite({ method: 'PUT', path: '/opportunities/abc/status', body: {} }, { dryRun: true })).rejects.toBeInstanceOf(CompanionWriteRefused);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the read-only client still throws on every non-GET', async () => {
    await expect(ghlRequest({ method: 'PUT', endpoint: '/opportunities/abc', family: 'opportunities', body: {} })).rejects.toBeInstanceOf(GhlReadOnlyViolation);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the WRITE key, the family Version header and a JSON body; the read key is never sent', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ succeded: true }), { status: 200 }));
    const r = await updateOpportunity('opp1', { pipelineId: 'pipe1', pipelineStageId: 'stage2', status: 'open' }, { dryRun: false });
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.name).toBe('update_opportunity');
    expect(r.request).toEqual({ method: 'PUT', path: '/opportunities/opp1', body: { pipelineId: 'pipe1', pipelineStageId: 'stage2', status: 'open' } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://services.leadconnectorhq.com/opportunities/opp1');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${WRITE_TOKEN}`);
    expect(headers.Version).toBe('2021-07-28');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ pipelineId: 'pipe1', pipelineStageId: 'stage2', status: 'open' }));
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(READ_TOKEN);

    await updateAppointmentStatus('ev1', 'noshow', { dryRun: false });
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((init2.headers as Record<string, string>).Version).toBe('v3');
    expect(init2.body).toBe(JSON.stringify({ appointmentStatus: 'noshow' }));

    await addContactNote('c1', 'Onboarding call · Consult', 'user9', { dryRun: false });
    const [url3, init3] = fetchSpy.mock.calls[2] as [string, RequestInit];
    expect(url3.endsWith('/contacts/c1/notes')).toBe(true);
    expect(init3.body).toBe(JSON.stringify({ body: 'Onboarding call · Consult', userId: 'user9' }));
  });

  it('the typed builders validate their input before any I/O', async () => {
    await expect(updateAppointmentStatus('ev1', 'no-show' as never, { dryRun: false })).rejects.toThrow();
    await expect(updateOpportunity('opp1', { pipelineId: 'p' }, { dryRun: false })).rejects.toThrow(/nothing to change/);
    await expect(updateOpportunity('opp 1', { pipelineId: 'p', status: 'won' }, { dryRun: false })).rejects.toThrow();
    await expect(addContactNote('c1', '', null, { dryRun: false })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dry run: the request is returned, nothing is sent, no key is needed', async () => {
    await setSetting(COMPANION_SETTING_KEYS.writeToken, '', { secret: true });
    const r = await updateAppointmentStatus('ev1', 'showed', { dryRun: true });
    expect(r).toMatchObject({ status: 'dry_run', httpStatus: null, request: { method: 'PUT', path: '/calendars/events/appointments/ev1', body: { appointmentStatus: 'showed' } } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no write key → a failed result naming Setup, nothing sent', async () => {
    await setSetting(COMPANION_SETTING_KEYS.writeToken, '', { secret: true });
    expect(await hasWriteKey()).toBe(false);
    expect(await getCompanionWriteConfig()).toEqual({ configured: false, preview: null });
    const r = await addContactNote('c1', 'a note of ten chars', null, { dryRun: false });
    expect(r).toMatchObject({ status: 'failed', error: NO_WRITE_KEY_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a 4xx is a failed result with the status and body; the token is never in it', async () => {
    fetchSpy.mockResolvedValue(new Response('{"message":"Unprocessable"}', { status: 422 }));
    const r = await updateAppointmentStatus('ev1', 'showed', { dryRun: false });
    expect(r.status).toBe('failed');
    expect(r.httpStatus).toBe(422);
    expect(r.error).toBe('GHL 422 PUT /calendars/events/appointments/ev1: {"message":"Unprocessable"}');
    expect(r.body).toBe('{"message":"Unprocessable"}');
    expect(JSON.stringify(r)).not.toContain(WRITE_TOKEN);
  });

  it('a network failure is a failed result; the token is scrubbed from the message', async () => {
    fetchSpy.mockRejectedValue(new Error(`socket hang up for Bearer ${WRITE_TOKEN}`));
    const r = await addContactNote('c1', 'a note of ten chars', null, { dryRun: false });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('[token]');
    expect(r.error).not.toContain(WRITE_TOKEN);
  });

  it('retries ONCE after a 429, honouring Retry-After', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const r = await addContactNote('c1', 'a note of ten chars', null, { dryRun: false });
    expect(r.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('an injected transport replaces fetch (the live test forces a failure this way)', async () => {
    const t = vi.fn(async () => new Response('{"message":"forced"}', { status: 500 }));
    setCompanionWriteTransport(t);
    const r = await updateAppointmentStatus('ev1', 'showed', { dryRun: false });
    expect(r).toMatchObject({ status: 'failed', httpStatus: 500 });
    expect(t).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('verifyWriteToken: a GET with the write key; 401 → the exact error; no key → the Setup message', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ pipelines: [{ id: 'p1', name: 'A', stages: [] }] }), { status: 200 }));
    const ok = await verifyWriteToken();
    expect(ok.ok).toBe(true);
    expect(ok.pipelineCount).toBe(1);
    expect(ok.message).toContain('companion:live-test');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://services.leadconnectorhq.com/opportunities/pipelines?locationId=loc_test');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${WRITE_TOKEN}`);

    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const bad = await verifyWriteToken();
    expect(bad).toEqual({ ok: false, message: 'Verification failed: GHL 401 GET /opportunities/pipelines: Unauthorized' });

    await setSetting(COMPANION_SETTING_KEYS.writeToken, '', { secret: true });
    expect(await verifyWriteToken()).toEqual({ ok: false, message: NO_WRITE_KEY_MESSAGE });
  });
});
