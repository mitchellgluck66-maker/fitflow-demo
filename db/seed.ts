/**
 * Demo seed — fabricated sample data so the UI can be seen before real
 * credentials exist. EVERY row written here has origin='demo' (CLAUDE.md
 * rule 6); the sample-data banner shows while any such row exists and
 * `POST /api/ghl/reset` removes them all.
 *
 * Deterministic PRNG, so re-running produces the same picture. Idempotent:
 * clears previous demo rows first, never touches ghl/manual rows.
 *
 * Run: npm run db:seed
 */

import { db, pipelines, stages, contacts, appointments, stageTransitions, adSpend } from './index';
import { runMigrations } from './migrate';
import { clearDemoData } from '../lib/provenance';
import { suggestRole } from '../lib/ghl/roles';
import { normalizeEmail, normalizePhone } from '../lib/ghl/transitions';
import type { SemanticRole } from './schema';

function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const random = makeRandom(20260616);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)];

const FIRST = ['Vanitha', 'August', 'June', 'James', 'Sarah', 'Alex', 'Jordan', 'Casey', 'Morgan', 'Taylor', 'Riley', 'Chris', 'Jamie', 'Kelly', 'Drew', 'Quinn', 'Blake', 'Avery', 'Dakota', 'Phoenix', 'Maya', 'Elena', 'Noah', 'Liam'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Lopez', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis'];
const SOURCES = ['Facebook', 'Facebook', 'Instagram', 'Instagram', 'Google', 'Referral', 'Website'];
const OWNERS = ['Miranda', 'Jake'];

/** Miranda's pipeline as it stands today. Names are demo — real ones come from GHL. */
const DEMO_PIPELINE = { id: 'demo-pipeline-application', name: '[demo] Application Pipeline' };
const DEMO_STAGES: Array<{ id: string; name: string }> = [
  { id: 'demo-stage-applied', name: 'Applied' },
  { id: 'demo-stage-consult-booked', name: 'Consult Booked' },
  { id: 'demo-stage-consult-noshow', name: 'Consult No Show' },
  { id: 'demo-stage-roadmap-booked', name: 'Pre-Roadmap Booked' },
  { id: 'demo-stage-roadmap-noshow', name: 'Roadmap No Show' },
  { id: 'demo-stage-roadmap-objection', name: 'Roadmap Completed: Objection' },
  { id: 'demo-stage-enrolled', name: 'Enrolled' },
];

/** Journey templates: the ordered stages a contact passed through. */
const JOURNEYS: Array<{ weight: number; path: string[]; status: 'open' | 'won' | 'lost' }> = [
  { weight: 18, path: ['demo-stage-applied'], status: 'open' },
  { weight: 10, path: ['demo-stage-applied', 'demo-stage-consult-booked'], status: 'open' },
  { weight: 14, path: ['demo-stage-applied', 'demo-stage-consult-booked', 'demo-stage-consult-noshow'], status: 'open' },
  { weight: 8, path: ['demo-stage-applied', 'demo-stage-consult-booked', 'demo-stage-roadmap-booked'], status: 'open' },
  { weight: 5, path: ['demo-stage-applied', 'demo-stage-consult-booked', 'demo-stage-roadmap-booked', 'demo-stage-roadmap-noshow'], status: 'open' },
  { weight: 4, path: ['demo-stage-applied', 'demo-stage-consult-booked', 'demo-stage-roadmap-booked', 'demo-stage-roadmap-objection'], status: 'lost' },
  { weight: 9, path: ['demo-stage-applied', 'demo-stage-consult-booked', 'demo-stage-roadmap-booked', 'demo-stage-enrolled'], status: 'won' },
];

function weightedJourney() {
  const total = JOURNEYS.reduce((s, j) => s + j.weight, 0);
  let r = random() * total;
  for (const j of JOURNEYS) {
    r -= j.weight;
    if (r <= 0) return j;
  }
  return JOURNEYS[0];
}

async function seed() {
  console.log('🌱 Seeding FitFlow demo data (origin=demo)…');
  await runMigrations();
  const removed = await clearDemoData();
  console.log(`  cleared previous demo rows: ${removed.contactsRemoved} contacts, ${removed.appointmentsRemoved} appointments`);

  const now = new Date();
  const prov = { source: 'demo', origin: 'demo', syncedAt: now, backfilled: false } as const;

  // Pipeline + stages, mapped through the same role mapper the real sync uses.
  await db.insert(pipelines).values({ ...DEMO_PIPELINE, position: 0, isTracked: true, ...prov });
  const roleOf = new Map<string, SemanticRole | null>();
  for (const [i, s] of DEMO_STAGES.entries()) {
    const suggestion = suggestRole(s.name);
    const role = suggestion.confident ? suggestion.role : null;
    roleOf.set(s.id, role);
    await db.insert(stages).values({
      id: s.id,
      pipelineId: DEMO_PIPELINE.id,
      name: s.name,
      position: i,
      semanticRole: role,
      roleSource: role ? 'auto' : 'unmapped',
      roleConfidence: suggestion.confidence,
      suggestedRole: suggestion.role,
      ...prov,
    });
  }

  // Contacts over the last ~10 weeks, back to June 16.
  const from = new Date('2026-06-16T12:00:00Z');
  const spanMs = now.getTime() - from.getTime();
  const count = 140;
  let appointmentsCreated = 0;
  let transitionsCreated = 0;

  for (let i = 0; i < count; i += 1) {
    const journey = weightedJourney();
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const source = pick(SOURCES);
    const owner = pick(OWNERS);
    const appliedAt = new Date(from.getTime() + random() * spanMs);
    const email = `${firstName}.${lastName}${i}@example.com`.toLowerCase();
    const phone = `+1${Math.floor(2000000000 + random() * 7999999999)}`;
    const finalStage = journey.path[journey.path.length - 1];

    // Walk the journey: each step 1–5 days after the previous.
    const times: Date[] = [appliedAt];
    for (let s = 1; s < journey.path.length; s += 1) {
      times.push(new Date(times[s - 1].getTime() + (1 + random() * 4) * 86_400_000));
    }
    // A journey can't be in the future.
    if (times[times.length - 1] > now) {
      continue;
    }

    const [contact] = await db
      .insert(contacts)
      .values({
        ghlContactId: `demo-contact-${i}`,
        ghlOpportunityId: `demo-opp-${i}`,
        pipelineId: DEMO_PIPELINE.id,
        stageId: finalStage,
        opportunityStatus: journey.status,
        opportunityName: `${firstName} ${lastName}`,
        monetaryValueCents: finalStage === 'demo-stage-enrolled' ? 299900 : random() > 0.6 ? 299900 : 0,
        lastStageChangeAt: times[times.length - 1],
        firstName,
        lastName,
        email,
        phone,
        emailNormalized: normalizeEmail(email),
        phoneNormalized: normalizePhone(phone),
        attributionSource: source,
        utmSource: source === 'Referral' ? null : source.toLowerCase(),
        utmMedium: source === 'Referral' ? 'referral' : 'paid_social',
        utmCampaign: source === 'Referral' ? null : `Summer Shred ${pick(['A', 'B', 'C'])}`,
        entryFunnel: 'Application 7.10',
        ownerName: owner,
        tags: ['demo'],
        ghlCreatedAt: appliedAt,
        ghlUpdatedAt: times[times.length - 1],
        ...prov,
      })
      .returning({ id: contacts.id });

    // Transition history.
    for (let s = 0; s < journey.path.length; s += 1) {
      await db.insert(stageTransitions).values({
        contactId: contact.id,
        ghlOpportunityId: `demo-opp-${i}`,
        pipelineId: DEMO_PIPELINE.id,
        fromStageId: s === 0 ? null : journey.path[s - 1],
        toStageId: journey.path[s],
        fromRole: s === 0 ? null : (roleOf.get(journey.path[s - 1]) ?? null),
        toRole: roleOf.get(journey.path[s]) ?? null,
        observedAt: times[s],
        previousObservedAt: s === 0 ? null : times[s - 1],
        kind: s === 0 ? 'initial' : 'diff',
        ...prov,
      });
      transitionsCreated += 1;
    }

    // Appointments implied by the journey.
    const addAppt = async (type: 'Consult' | 'Roadmap', at: Date, status: 'showed' | 'noshow' | 'confirmed') => {
      await db.insert(appointments).values({
        ghlEventId: `demo-event-${i}-${type}`,
        ghlCalendarId: `demo-calendar-${type.toLowerCase()}`,
        calendarName: type === 'Consult' ? 'Discovery Consult' : 'Roadmap Session',
        ghlContactId: `demo-contact-${i}`,
        contactId: contact.id,
        ghlOpportunityId: `demo-opp-${i}`,
        type,
        title: `${type} with ${firstName} ${lastName}`,
        startTime: at,
        endTime: new Date(at.getTime() + 30 * 60_000),
        timezone: 'America/New_York',
        assignedTo: owner,
        ghlStatus: status,
        outcome: status === 'showed' ? 'showed' : status === 'noshow' ? 'no_show' : null,
        ...prov,
      });
      appointmentsCreated += 1;
    };

    const idx = (id: string) => journey.path.indexOf(id);
    if (idx('demo-stage-consult-booked') >= 0) {
      const bookedAt = times[idx('demo-stage-consult-booked')];
      const consultAt = new Date(bookedAt.getTime() + (1 + random() * 3) * 86_400_000);
      const noShow = idx('demo-stage-consult-noshow') >= 0;
      const progressed = idx('demo-stage-roadmap-booked') >= 0;
      await addAppt('Consult', consultAt, noShow ? 'noshow' : progressed ? 'showed' : consultAt < now ? (random() > 0.3 ? 'showed' : 'noshow') : 'confirmed');
    }
    if (idx('demo-stage-roadmap-booked') >= 0) {
      const bookedAt = times[idx('demo-stage-roadmap-booked')];
      const roadmapAt = new Date(bookedAt.getTime() + (2 + random() * 4) * 86_400_000);
      const noShow = idx('demo-stage-roadmap-noshow') >= 0;
      const done = idx('demo-stage-enrolled') >= 0 || idx('demo-stage-roadmap-objection') >= 0;
      await addAppt('Roadmap', roadmapAt, noShow ? 'noshow' : done ? 'showed' : roadmapAt < now ? 'showed' : 'confirmed');
    }
  }

  // A few upcoming appointments so "today" is not empty.
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(now.getTime() + (i * 2 + 1) * 3_600_000);
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const [contact] = await db
      .insert(contacts)
      .values({
        ghlContactId: `demo-contact-upcoming-${i}`,
        ghlOpportunityId: `demo-opp-upcoming-${i}`,
        pipelineId: DEMO_PIPELINE.id,
        stageId: i % 2 === 0 ? 'demo-stage-consult-booked' : 'demo-stage-roadmap-booked',
        opportunityStatus: 'open',
        firstName,
        lastName,
        email: `${firstName}.${lastName}.up${i}@example.com`.toLowerCase(),
        attributionSource: pick(SOURCES),
        ownerName: pick(OWNERS),
        ghlCreatedAt: new Date(now.getTime() - 5 * 86_400_000),
        ...prov,
      })
      .returning({ id: contacts.id });
    await db.insert(appointments).values({
      ghlEventId: `demo-event-upcoming-${i}`,
      ghlCalendarId: i % 2 === 0 ? 'demo-calendar-consult' : 'demo-calendar-roadmap',
      calendarName: i % 2 === 0 ? 'Discovery Consult' : 'Roadmap Session',
      ghlContactId: `demo-contact-upcoming-${i}`,
      contactId: contact.id,
      type: i % 2 === 0 ? 'Consult' : 'Roadmap',
      title: `${i % 2 === 0 ? 'Consult' : 'Roadmap'} with ${firstName} ${lastName}`,
      startTime: at,
      endTime: new Date(at.getTime() + 30 * 60_000),
      timezone: 'America/New_York',
      assignedTo: pick(OWNERS),
      ghlStatus: 'confirmed',
      outcome: null,
      ...prov,
    });
    appointmentsCreated += 1;
  }

  // Manual weekly ad spend (Sun–Sat weeks) so CAC has something to divide by.
  const sunday = new Date(from);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  for (let w = 0; w < 11; w += 1) {
    const weekStart = new Date(sunday.getTime() + w * 7 * 86_400_000);
    if (weekStart > now) break;
    const date = weekStart.toISOString().slice(0, 10);
    for (const platform of ['meta', 'google'] as const) {
      await db.insert(adSpend).values({
        platform,
        externalId: `manual:${platform}:${date}`,
        campaignName: platform === 'meta' ? 'Summer Shred (demo)' : 'Brand search (demo)',
        date,
        spendCents: Math.round((platform === 'meta' ? 1800 + random() * 900 : 400 + random() * 200) * 100),
        enteredBy: 'demo seed',
        ...prov,
      });
    }
  }

  console.log(`✓ Seeded demo pipeline (${DEMO_STAGES.length} stages), ${count} contacts, ${appointmentsCreated} appointments, ${transitionsCreated} transitions.`);
  console.log('  Unmapped demo stages (need a human role):', DEMO_STAGES.filter((s) => !roleOf.get(s.id)).map((s) => s.name).join(', ') || 'none');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  });
