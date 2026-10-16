/**
 * Companion stage 1, item 3 — the pop-out: days-in-pipeline precedence, notes ok / unavailable, search merge, the
 * pop-out helpers, and the brief service on PGlite (followed-pipeline opportunity date, mirror event context,
 * the live name for a contact outside the mirror).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, appointments, contacts, ghlOpportunities, pipelines, stages } from '@/db';
import { daysInPipelineOf, shapeNotes, mergeSearch, assembleBrief, liveContactName } from '@/lib/companion/brief';
import { getBrief, searchPeople } from '@/lib/companion/briefService';
import { readBriefContact, searchMirrorContacts } from '@/lib/companion/mirror';
import { supportsDocumentPip, popOutMode, popOutUrl, pipDocumentHtml, popupFeatures } from '@/lib/companion/popout';
import { GhlNotesResponseSchema, GhlNoteSchema, GhlContactsSearchResponseSchema, GhlContactSummarySchema, parseMany } from '@/lib/ghl/schemas';

const now = new Date('2026-10-16T16:00:00Z');

describe('brief (pure)', () => {
  it('days in pipeline: followed opportunity → contact opportunity → contact created (labelled) → null', () => {
    expect(daysInPipelineOf({ opportunityCreatedAt: '2026-10-12T15:00:00Z', contactOpportunityCreatedAt: '2026-10-01T00:00:00Z', contactCreatedAt: '2026-09-01T00:00:00Z' }, now)).toEqual({ days: 4, since: 'application', fromIso: '2026-10-12T15:00:00.000Z' });
    expect(daysInPipelineOf({ opportunityCreatedAt: null, contactOpportunityCreatedAt: '2026-10-01T00:00:00Z', contactCreatedAt: '2026-09-01T00:00:00Z' }, now)).toMatchObject({ days: 15, since: 'application' });
    expect(daysInPipelineOf({ opportunityCreatedAt: null, contactOpportunityCreatedAt: null, contactCreatedAt: '2026-09-01T00:00:00Z' }, now)).toMatchObject({ days: 45, since: 'contact created' });
    expect(daysInPipelineOf({ opportunityCreatedAt: null, contactOpportunityCreatedAt: null, contactCreatedAt: null }, now)).toBeNull();
    expect(daysInPipelineOf({ opportunityCreatedAt: 'garbage', contactOpportunityCreatedAt: null, contactCreatedAt: '2026-10-16T20:00:00Z' }, now)).toMatchObject({ days: 0 }); // future-dated → 0, never negative
  });

  it('notes: the last 3 with the author; a failed read is "unavailable" with the reason (never an empty list)', () => {
    const notes = [1, 2, 3, 4].map((i) => ({ id: `n${i}`, body: `note ${i}`, dateAdded: `2026-10-1${i}T00:00:00Z`, userId: i === 1 ? 'u1' : null }));
    const ok = shapeNotes({ notes }, (u) => (u === 'u1' ? 'Miranda' : null));
    expect(ok).toMatchObject({ status: 'ok', total: 4 });
    expect(ok.status === 'ok' && ok.items.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    expect(ok.status === 'ok' && ok.items[0].author).toBe('Miranda');
    expect(shapeNotes({ notes: [], error: 'GHL 403 GET /contacts/c1/notes: forbidden' })).toEqual({ status: 'unavailable', reason: 'GHL 403 GET /contacts/c1/notes: forbidden' });
    expect(shapeNotes({ notes: [] })).toEqual({ status: 'ok', total: 0, items: [] });
  });

  it('search merge: mirror first with the FitFlow id, live rows added once, overlap marked both, the live error kept', () => {
    const m = [{ ghlContactId: 'a', contactId: 'ff-a', name: 'Ann', email: 'ann@x.com', phone: null }];
    const r = mergeSearch(m, { contacts: [{ id: 'a', name: 'Ann Live', email: null, phone: null }, { id: 'b', name: 'Bob', email: 'bob@x.com', phone: null }, { id: 'b', name: 'Bob again', email: null, phone: null }], error: undefined });
    expect(r.results.map((x) => [x.ghlContactId, x.source, x.contactId])).toEqual([['a', 'both', 'ff-a'], ['b', 'live', null]]);
    expect(r.liveError).toBeNull();
    expect(mergeSearch(m, { contacts: [], error: 'GHL 429' })).toMatchObject({ liveError: 'GHL 429' });
    expect(mergeSearch(m, null).results).toHaveLength(1);
    expect(liveContactName({ id: 'x', firstName: 'A', lastName: null })).toBe('A');
    expect(liveContactName({ id: 'x', name: 'Full Name' })).toBe('Full Name');
    expect(liveContactName({ id: 'abcdefgh', email: null })).toBe('Contact abcdef…');
  });

  it('assembleBrief: mirror beats live; outside the mirror the live name and no stage / days', () => {
    const notes = { status: 'ok' as const, total: 0, items: [] };
    const b = assembleBrief({ ghlContactId: 'c1', mirror: { ghlContactId: 'c1', contactId: 'ff', name: 'Jane Doe', email: 'j@x.com', phone: null, stage: { name: 'Consult booked', role: 'consult_booked', pipeline: 'App' }, opportunityCreatedAt: '2026-10-12T00:00:00Z', contactOpportunityCreatedAt: null, contactCreatedAt: null }, live: { name: 'Jane Live', email: 'live@x.com', phone: '+1' }, call: null, notes, now });
    expect(b.contact).toEqual({ ghlContactId: 'c1', contactId: 'ff', name: 'Jane Doe', email: 'j@x.com', phone: '+1', inMirror: true }); // the mirror wins; live fills a gap
    expect(b.daysInPipeline?.days).toBe(4);
    const o = assembleBrief({ ghlContactId: 'c2abcdef', mirror: null, live: { name: 'Only Live', email: null, phone: null }, call: null, notes, now });
    expect(o.contact).toMatchObject({ name: 'Only Live', inMirror: false });
    expect(o.stage).toBeNull();
    expect(o.daysInPipeline).toBeNull();
    expect(assembleBrief({ ghlContactId: 'c3abcdef', mirror: null, live: null, call: null, notes, now }).contact.name).toBe('Unknown contact c3abcd…');
  });

  it('pop-out helpers: feature detection, the URL (float=0 for a plain window), the PiP document', () => {
    expect(supportsDocumentPip({ documentPictureInPicture: { requestWindow: async () => ({}) as Window } })).toBe(true);
    expect(supportsDocumentPip({})).toBe(false);
    expect(supportsDocumentPip(null)).toBe(false);
    expect(popOutMode({})).toBe('window');
    expect(popOutUrl({ date: '2026-10-16', user: null, event: 'e1', mode: 'document_pip' })).toBe('/companion/popout?date=2026-10-16&event=e1');
    expect(popOutUrl({ mode: 'window' })).toBe('/companion/popout?float=0');
    expect(pipDocumentHtml('/companion/popout?a=1')).toContain('<iframe src="/companion/popout?a=1"');
    expect(popupFeatures()).toContain('width=360');
  });

  it('schemas: notes and the contact search accept GHL shapes and reject rows without an id', () => {
    const notes = GhlNotesResponseSchema.parse({ notes: [{ id: 'n1', body: 'hi', userId: 'u', dateAdded: '2026-10-01T00:00:00.000Z', contactId: 'c' }, { body: 'no id' }] });
    const parsed = parseMany(GhlNoteSchema, notes.notes, 'note');
    expect(parsed.valid).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
    const search = GhlContactsSearchResponseSchema.parse({ contacts: [{ id: 'c1', firstName: 'A', email: 'a@x.com' }], meta: { total: '1' } });
    expect(parseMany(GhlContactSummarySchema, search.contacts, 'contact').valid[0]).toMatchObject({ id: 'c1', firstName: 'A' });
  });
});

describe('brief service on PGlite', () => {
  const prov = { source: 'ghl', origin: 'ghl', syncedAt: now, backfilled: false } as const;
  beforeAll(async () => {
    await runMigrations();
    await db.insert(pipelines).values([
      { id: 'p-followed', name: '[new] Application Pipeline', isTracked: true, ...prov },
      { id: 'p-other', name: 'Alumni', isTracked: false, ...prov },
    ]);
    await db.insert(stages).values({ id: 's1', pipelineId: 'p-followed', name: 'Roadmap Booked', position: 4, semanticRole: 'roadmap_booked', ...prov });
    await db.insert(contacts).values([
      { ghlContactId: 'c-jane', pipelineId: 'p-followed', stageId: 's1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '+14035550100', opportunityCreatedAt: new Date('2026-10-01T00:00:00Z'), ghlCreatedAt: new Date('2026-09-01T00:00:00Z'), ...prov },
      { ghlContactId: 'c-old', firstName: 'Old', lastName: 'Lead', email: 'old@example.com', ghlCreatedAt: new Date('2026-06-01T00:00:00Z'), ...prov },
    ]);
    await db.insert(ghlOpportunities).values([
      { id: 'o-alumni', ghlContactId: 'c-jane', pipelineId: 'p-other', status: 'open', ghlCreatedAt: new Date('2026-08-01T00:00:00Z'), ...prov }, // unfollowed → ignored
      { id: 'o-app', ghlContactId: 'c-jane', pipelineId: 'p-followed', stageId: 's1', status: 'open', ghlCreatedAt: new Date('2026-10-12T15:00:00Z'), ...prov },
    ]);
    await db.insert(appointments).values({ ghlEventId: 'ev-1', ghlCalendarId: 'cal-r', calendarName: 'Internal: Roadmap Building Session', ghlContactId: 'c-jane', type: 'Roadmap', startTime: new Date('2026-10-16T17:00:00Z'), endTime: new Date('2026-10-16T18:00:00Z'), timezone: 'America/Edmonton', ghlStatus: 'confirmed', ...prov });
  });

  it('readBriefContact: the followed-pipeline opportunity dates the application; the stage and pipeline come along', async () => {
    const jane = await readBriefContact('c-jane');
    expect(jane).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com', stage: { name: 'Roadmap Booked', pipeline: '[new] Application Pipeline' }, opportunityCreatedAt: '2026-10-12T15:00:00.000Z', contactOpportunityCreatedAt: '2026-10-01T00:00:00.000Z', contactCreatedAt: '2026-09-01T00:00:00.000Z' });
    expect(await readBriefContact('nope')).toBeNull();
  });

  it('getBrief: mirror event context, 4 days since application, notes unavailable reported; a contact outside the mirror takes the live name', async () => {
    const b = await getBrief({ ghlContactId: 'c-jane', eventId: 'ev-1', now }, { notes: async () => ({ status: 'unavailable', reason: 'GHL 403 GET /contacts/c-jane/notes: missing scope' }), liveContact: async () => null });
    expect(b.call).toMatchObject({ eventId: 'ev-1', callType: 'Roadmap', calendarName: 'Internal: Roadmap Building Session', startIso: '2026-10-16T17:00:00.000Z' });
    expect(b.daysInPipeline).toEqual({ days: 4, since: 'application', fromIso: '2026-10-12T15:00:00.000Z' });
    expect(b.notes).toEqual({ status: 'unavailable', reason: 'GHL 403 GET /contacts/c-jane/notes: missing scope' });
    const old = await getBrief({ ghlContactId: 'c-old', eventId: null, now }, { notes: async () => ({ status: 'ok', total: 0, items: [] }) });
    expect(old.daysInPipeline).toMatchObject({ since: 'contact created' });
    expect(old.stage).toBeNull();
    const outside = await getBrief({ ghlContactId: 'c-live-only', eventId: null, now }, { notes: async () => ({ status: 'ok', total: 0, items: [] }), liveContact: async () => ({ name: 'Live Person', email: 'live@example.com', phone: null }) });
    expect(outside.contact).toMatchObject({ name: 'Live Person', inMirror: false, contactId: null });
    expect(outside.daysInPipeline).toBeNull();
  });

  it('search: the mirror matches name / email / phone case-insensitively; the live half merges and its error is reported; < 2 chars = nothing', async () => {
    expect((await searchMirrorContacts('jane')).map((r) => r.ghlContactId)).toEqual(['c-jane']);
    expect((await searchMirrorContacts('EXAMPLE.com')).map((r) => r.ghlContactId).sort()).toEqual(['c-jane', 'c-old']);
    expect((await searchMirrorContacts('5550100')).map((r) => r.ghlContactId)).toEqual(['c-jane']);
    expect(await searchMirrorContacts('%')).toEqual([]);
    const r = await searchPeople('jane', { live: async () => ({ contacts: [{ id: 'c-jane', name: 'Jane', email: null, phone: null }, { id: 'c-new', name: 'Jane New', email: 'new@example.com', phone: null }] }) });
    expect(r.results.map((x) => [x.ghlContactId, x.source])).toEqual([['c-jane', 'both'], ['c-new', 'live']]);
    const failed = await searchPeople('jane', { live: async () => ({ contacts: [], error: 'GHL 401 GET /contacts/: Unauthorized' }) });
    expect(failed).toMatchObject({ liveError: 'GHL 401 GET /contacts/: Unauthorized' });
    expect(failed.results.map((x) => x.source)).toEqual(['mirror']);
    const thrown = await searchPeople('jane', { live: async () => { throw new Error('socket hang up'); } });
    expect(thrown.liveError).toBe('socket hang up');
    expect(await searchPeople('j', { live: async () => ({ contacts: [] }) })).toEqual({ results: [], liveError: null });
  });
});
