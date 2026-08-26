/**
 * Seeds appointment history plus today's schedule.
 *
 * Generates ~30 days of past appointments with realistic outcomes so the
 * Metrics tab has genuine trends to plot, then leaves today's appointments
 * unmarked so the Today View has real work to do.
 *
 * Outcome probabilities vary by source and appointment type rather than being
 * uniform random - otherwise every chart converges on the same number and the
 * analytics look plausible but say nothing.
 */

import { db, leads, appointments } from './index';
import { eq } from 'drizzle-orm';

const TIMEZONE = 'America/New_York';

/** Deterministic PRNG so re-running the seed produces the same charts. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const random = makeRandom(20260819);

/** Per-source behaviour. Referrals show up and convert; cold paid traffic doesn't. */
const SOURCE_PROFILE: Record<string, { show: number; rebook: number }> = {
  Referral: { show: 0.92, rebook: 0.78 },
  Website: { show: 0.81, rebook: 0.62 },
  Google: { show: 0.74, rebook: 0.55 },
  Instagram: { show: 0.63, rebook: 0.44 },
  Facebook: { show: 0.58, rebook: 0.38 },
  TikTok: { show: 0.49, rebook: 0.31 },
};
const DEFAULT_PROFILE = { show: 0.7, rebook: 0.5 };

/** Roadmaps are further down the funnel, so they convert better than consults. */
const TYPE_MODIFIER: Record<string, { show: number; rebook: number }> = {
  Consult: { show: 0, rebook: 0 },
  Roadmap: { show: 0.06, rebook: 0.12 },
  'Follow-Up': { show: 0.1, rebook: -0.05 },
  'Check-In': { show: 0.14, rebook: -0.1 },
};

const TYPES = ['Consult', 'Consult', 'Consult', 'Roadmap', 'Roadmap', 'Follow-Up', 'Check-In'];
const OWNERS = ['Sarah', 'Jake', 'Miranda', 'Team Lead'];

/** Rep skill differences, so owner comparison isn't noise. */
const OWNER_MODIFIER: Record<string, number> = {
  Sarah: 0.1,
  Jake: -0.04,
  Miranda: 0.05,
  'Team Lead': -0.08,
};

function dateKey(offsetDays: number): { y: number; m: number; d: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = parts.split('-').map(Number);

  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);

  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

function isoAt(offsetDays: number, hour: number, minute: number): string {
  const { y, m, d } = dateKey(offsetDays);

  // Resolve the zone offset on that specific date so DST is handled.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const localHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hour12: false,
    }).format(probe),
  );
  const offsetHours = 12 - localHour;

  return new Date(Date.UTC(y, m - 1, d, hour + offsetHours, minute)).toISOString();
}

const SLOTS = [
  { hour: 9, minute: 0 },
  { hour: 9, minute: 45 },
  { hour: 10, minute: 30 },
  { hour: 11, minute: 30 },
  { hour: 13, minute: 0 },
  { hour: 14, minute: 0 },
  { hour: 14, minute: 45 },
  { hour: 15, minute: 30 },
  { hour: 16, minute: 30 },
  { hour: 17, minute: 15 },
];

const HISTORY_DAYS = 30;

async function seedAppointments() {
  console.log('Seeding appointment history…');

  // Only remove fabricated rows. Re-running the seed must never destroy real
  // data imported from GoHighLevel.
  await db.delete(appointments).where(eq(appointments.origin, 'demo'));

  const allLeads = await db.select().from(leads);
  if (allLeads.length === 0) {
    console.log('No leads found. Run `npm run db:seed` first.');
    return;
  }

  // Today's roster is drawn only from leads who plausibly have an appointment
  // booked. Putting an already-Enrolled lead on today's consult sheet is the
  // kind of detail that makes demo data read as fake.
  const BOOKABLE_STAGES = [
    'Applied',
    'Consult Booked',
    'Consult No Show',
    'Pre-Roadmap Booked',
    'Roadmap No Show',
  ];
  const bookableLeads = allLeads.filter((l) => BOOKABLE_STAGES.includes(l.stage));
  const todaysPool = bookableLeads.length > 0 ? bookableLeads : allLeads;

  const rows: Array<Record<string, unknown>> = [];
  let leadCursor = 0;
  let todayCursor = 0;

  for (let offset = -HISTORY_DAYS; offset <= 0; offset += 1) {
    const { y, m, d } = dateKey(offset);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    // Weekends are quiet - a flat 10/day across a month looks synthetic.
    if (weekday === 0) continue;
    const isSaturday = weekday === 6;

    // Volume drifts upward over the window so the trend line has a story.
    const growth = 1 + ((offset + HISTORY_DAYS) / HISTORY_DAYS) * 0.35;
    const base = isSaturday ? 3 : 6;
    const count = Math.max(
      2,
      Math.min(SLOTS.length, Math.round((base + random() * 4) * growth)),
    );

    for (let i = 0; i < count; i += 1) {
      const isToday = offset === 0;

      let lead;
      if (isToday) {
        lead = todaysPool[todayCursor % todaysPool.length];
        todayCursor += 1;
      } else {
        lead = allLeads[leadCursor % allLeads.length];
        leadCursor += 1;
      }

      const slot = SLOTS[i % SLOTS.length];
      // Today's sheet is consults and roadmaps - the appointments that carry an
      // attendance decision - rather than the full mix.
      const type = isToday
        ? (['Consult', 'Consult', 'Roadmap', 'Consult', 'Roadmap', 'Follow-Up'][
            i % 6
          ] as string)
        : TYPES[Math.floor(random() * TYPES.length)];
      const owner = OWNERS[Math.floor(random() * OWNERS.length)];
      const start = isoAt(offset, slot.hour, slot.minute);
      const duration = type === 'Roadmap' ? 45 : type === 'Consult' ? 30 : 20;

      const profile = SOURCE_PROFILE[lead.source ?? ''] ?? DEFAULT_PROFILE;
      const typeMod = TYPE_MODIFIER[type] ?? { show: 0, rebook: 0 };
      const ownerMod = OWNER_MODIFIER[owner] ?? 0;

      const showChance = Math.min(0.97, profile.show + typeMod.show);
      const rebookChance = Math.min(0.95, profile.rebook + typeMod.rebook + ownerMod);

      // Today's appointments stay unmarked - that's the staff's job.
      let outcome: string | null = null;
      let markedAt: string | null = null;

      if (!isToday) {
        const showed = random() < showChance;
        outcome = !showed ? 'no_show' : random() < rebookChance ? 'booked' : 'not_continuing';
        markedAt = isoAt(offset, 18, 30);
      }

      const index = rows.length + 1;

      rows.push({
        leadId: lead.id,
        type,
        title: `${type} — ${lead.firstName} ${lead.lastName}`,
        startTime: start,
        endTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString(),
        timezone: TIMEZONE,
        assignedTo: owner,
        outcome,
        outcomeMarkedAt: markedAt,
        outcomeMarkedBy: markedAt ? owner : null,
        ghlAppointmentStatus:
          outcome === 'no_show' ? 'noshow' : outcome ? 'showed' : 'confirmed',
        // Placeholder GHL ids so dry-run previews show realistic payloads.
        ghlEventId: `demo-event-${index}`,
        ghlContactId: `demo-contact-${index}`,
        ghlOpportunityId: `demo-opp-${index}`,
        origin: 'demo',
        syncStatus: outcome ? 'synced' : 'pending',
        syncedAt: markedAt,
        createdAt: start,
        updatedAt: markedAt ?? start,
      });
    }
  }

  // Insert in chunks - SQLite caps bound parameters per statement.
  const CHUNK = 40;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(appointments).values(rows.slice(i, i + CHUNK) as never);
  }

  const todays = rows.filter((r) => r.outcome === null);
  const booked = rows.filter((r) => r.outcome === 'booked').length;
  const noShow = rows.filter((r) => r.outcome === 'no_show').length;
  const notCont = rows.filter((r) => r.outcome === 'not_continuing').length;

  console.log(`Seeded ${rows.length} appointments across ${HISTORY_DAYS + 1} days.`);
  console.log(`   Today (unmarked): ${todays.length}`);
  console.log(`   Historical — booked: ${booked}, no-show: ${noShow}, not continuing: ${notCont}`);
}

seedAppointments()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
