/**
 * Rich demo dataset — `npm run db:seed:demo`.
 *
 * A realistic, internally consistent story from 2026-06-16 → today for the
 * CEO demo. EVERY row is origin='demo' / source='demo' (CLAUDE.md rule 6), the
 * sample-data banner shows while any exists, and `npm run db:wipe:demo`
 * removes all of it. Idempotent: wipes demo rows first, then inserts.
 *
 * Works against the embedded PGlite DB (no DATABASE_URL) and against a
 * DATABASE_URL (db/index.ts loads .env.local for CLI runs).
 *
 * The story:
 *   - ~200 leads: Facebook "Summer Shred — Broad" (the winner: cheap leads,
 *     good show rate), Facebook "Summer Shred — Retargeting" (the loser:
 *     pricey, worse show rate), Google "Brand Search" (few, cheap, high
 *     intent), Referral (best converting) and a trickle from the Website.
 *   - Weekly volume dips in early July and pushes through August.
 *   - Recovered no-shows, upcoming appointments, fresh applicants for the
 *     daily to-do, ~15 enrollments with Stripe-like payments (2 failed, 1
 *     refund, 3 subscriptions, 2 unmatched), daily campaign spend, three
 *     pre-generated insight reports + one weekly narrative (model 'demo'),
 *     a few weeks of digest history and some sync runs.
 */

import { sql } from 'drizzle-orm';
import {
  db,
  pipelines,
  stages,
  contacts,
  appointments,
  stageTransitions,
  adSpend,
  payments,
  aiReports,
  emailDigests,
  syncRuns,
  ghlOpportunities,
  appUsers,
} from './index';
import { runMigrations } from './migrate';
import { hashPassword } from '../lib/auth/password';
import { clearDemoData } from '../lib/provenance';
import { suggestRole } from '../lib/ghl/roles';
import { normalizeEmail, normalizePhone } from '../lib/ghl/transitions';
import { getTimezone, setSetting, SETTING_KEYS } from '../lib/settings';
import { runPaymentClassification } from '../lib/stripe/classify';
import { runAttributionClassification } from '../lib/attribution/run';
import { addDays, weekStart, weekEnd, resolvePreset, formatRangeLabel, todayInTimezone, localDate } from '../lib/dates';
import type { SemanticRole } from './schema';

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const SEED = 20260616;
let rng = makeRandom(SEED);
const random = () => rng();
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)];
const chance = (p: number) => random() < p;
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const jitter = (n: number, pct: number) => n * (1 + between(-pct, pct));

/**
 * The story's local days are the BUSINESS timezone's (settings.timezone, America/Edmonton since migration 0011) — the
 * engine and the verify SQL bucket by it, so the seed must too (2026-10-18: a New York constant had the seed's "today"
 * and its day boundaries two hours off the engine's). Set from settings when the seed runs; never New York.
 */
let TZ = 'America/Edmonton';
const DAY = 86_400_000;
const START_DATE = '2026-06-16';

const FIRST = ['Vanitha', 'August', 'June', 'James', 'Sarah', 'Alex', 'Jordan', 'Casey', 'Morgan', 'Taylor', 'Riley', 'Chris', 'Jamie', 'Kelly', 'Drew', 'Quinn', 'Blake', 'Avery', 'Dakota', 'Phoenix', 'Maya', 'Elena', 'Noah', 'Liam', 'Priya', 'Marcus', 'Sofia', 'Ethan', 'Grace', 'Omar', 'Hannah', 'Leo', 'Nina', 'Caleb', 'Isla', 'Mateo', 'Zoe', 'Ravi', 'Tessa', 'Julian'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Lopez', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis', 'Patel', 'Nguyen', 'Kim', 'Okafor', 'Silva', 'Chen', 'Murphy', 'Reyes', 'Foster', 'Bennett'];
const OWNERS = ['Miranda', 'Jake'];
/** Companion stage 1: the demo onboarding login and the demo GHL user her appointments are assigned to. */
export const DEMO_COMPANION_USER = { name: 'Miranda Demo', email: 'miranda@fitflow.demo', password: 'demo-companion', ghlUserId: 'demo-user-miranda' } as const;
const DEMO_GHL_USER_OF: Record<string, string> = { Miranda: DEMO_COMPANION_USER.ghlUserId, Jake: 'demo-user-jake' };
/** Names of the unmatched Stripe customers (emails FitFlow has never seen). */
const UNMATCHED_CUSTOMERS: Array<[string, string]> = [['m.okonkwo', 'maria.okonkwo@gmail.com'], ['t.reyes', 'tomas.reyes.fit@outlook.com']];
const customerNameOf = (email: string) => email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Every person name the demo tenant can produce — the fixture guard allows nothing else (design review 2026-10-03, B). */
export const DEMO_PEOPLE = {
  first: FIRST,
  last: LAST,
  owners: OWNERS,
  allNames(): Set<string> {
    const out = new Set<string>();
    for (const f of FIRST) for (const l of LAST) out.add(`${f} ${l}`);
    for (const o of OWNERS) out.add(o);
    for (const [, email] of UNMATCHED_CUSTOMERS) out.add(customerNameOf(email));
    out.add('Unknown');
    return out;
  },
};

// ---------------------------------------------------------------------------
// Pipeline / stages (same ids as the small seed so both can coexist)
// ---------------------------------------------------------------------------

const PIPELINE = { id: 'demo-pipeline-application', name: '[demo] Application Pipeline' };
/** An UNFOLLOWED pipeline a few form applicants get routed to by mistake (data-quality class X). */
const NURTURE = { id: 'demo-pipeline-nurture', name: '[demo] Nurture' };
const NURTURE_STAGE = 'demo-stage-nurture-new';
const STAGE = {
  applied: 'demo-stage-applied',
  consultBooked: 'demo-stage-consult-booked',
  consultNoShow: 'demo-stage-consult-noshow',
  roadmapBooked: 'demo-stage-roadmap-booked',
  roadmapNoShow: 'demo-stage-roadmap-noshow',
  roadmapObjection: 'demo-stage-roadmap-objection',
  enrolled: 'demo-stage-enrolled',
} as const;
const STAGE_NAMES: Record<string, string> = {
  [STAGE.applied]: 'Applied',
  [STAGE.consultBooked]: 'Consult Booked',
  [STAGE.consultNoShow]: 'Consult No Show',
  [STAGE.roadmapBooked]: 'Pre-Roadmap Booked',
  [STAGE.roadmapNoShow]: 'Roadmap No Show',
  [STAGE.roadmapObjection]: 'Roadmap Completed: Objection',
  [STAGE.enrolled]: 'Enrolled',
};

// ---------------------------------------------------------------------------
// Sources & campaigns
// ---------------------------------------------------------------------------

interface SourceDef {
  key: string;
  source: string;
  weight: number;
  utmSource: string | null;
  utmMedium: string | null;
  campaign: string | null;
  /** Journey probabilities. */
  pBook: number;
  pShow: number;
  pRoadmapBook: number;
  pRoadmapShow: number;
  pEnroll: number;
}

const SOURCES: SourceDef[] = [
  { key: 'broad', source: 'Facebook', weight: 35, utmSource: 'facebook', utmMedium: 'paid_social', campaign: 'Summer Shred — Broad', pBook: 0.62, pShow: 0.74, pRoadmapBook: 0.56, pRoadmapShow: 0.76, pEnroll: 0.5 },
  { key: 'retarget', source: 'Facebook', weight: 20, utmSource: 'facebook', utmMedium: 'paid_social', campaign: 'Summer Shred — Retargeting', pBook: 0.52, pShow: 0.55, pRoadmapBook: 0.5, pRoadmapShow: 0.7, pEnroll: 0.42 },
  { key: 'google', source: 'Google', weight: 25, utmSource: 'google', utmMedium: 'cpc', campaign: 'Brand Search', pBook: 0.66, pShow: 0.76, pRoadmapBook: 0.58, pRoadmapShow: 0.78, pEnroll: 0.52 },
  { key: 'referral', source: 'Referral', weight: 15, utmSource: null, utmMedium: 'referral', campaign: null, pBook: 0.72, pShow: 0.88, pRoadmapBook: 0.66, pRoadmapShow: 0.85, pEnroll: 0.62 },
  { key: 'website', source: 'Website', weight: 5, utmSource: 'organic', utmMedium: 'organic', campaign: null, pBook: 0.55, pShow: 0.7, pRoadmapBook: 0.5, pRoadmapShow: 0.75, pEnroll: 0.45 },
];

function pickSource(): SourceDef {
  const total = SOURCES.reduce((s, d) => s + d.weight, 0);
  let r = random() * total;
  for (const d of SOURCES) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return SOURCES[0];
}

interface CampaignDef {
  id: string;
  name: string;
  platform: 'meta' | 'google';
  dailyBefore: number; // dollars, before the mid-July increase
  dailyAfter: number;
  cpl: number; // dollars per platform-reported lead
  cpc: number;
  ctr: number;
}

const CAMPAIGNS: CampaignDef[] = [
  { id: 'demo-fb-broad', name: 'Summer Shred — Broad', platform: 'meta', dailyBefore: 95, dailyAfter: 130, cpl: 18, cpc: 1.6, ctr: 0.025 },
  { id: 'demo-fb-retarget', name: 'Summer Shred — Retargeting', platform: 'meta', dailyBefore: 60, dailyAfter: 75, cpl: 45, cpc: 2.4, ctr: 0.018 },
  { id: 'demo-google-brand', name: 'Brand Search', platform: 'google', dailyBefore: 28, dailyAfter: 32, cpl: 12, cpc: 3.0, ctr: 0.06 },
];

// ---------------------------------------------------------------------------
// Journey generation
// ---------------------------------------------------------------------------

interface Lead {
  i: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  def: SourceDef;
  owner: string;
  appliedAt: Date;
  /** Ordered stage ids with the instant each was entered. */
  path: Array<{ stageId: string; at: Date }>;
  appts: Array<{ type: 'Consult' | 'Roadmap'; at: Date; status: 'showed' | 'noshow' | 'cancelled' | 'confirmed'; seq: number }>;
  recovered: boolean;
  finalStage: string;
  status: 'open' | 'won' | 'lost';
  enrolledAt: Date | null;
  /** Data-quality classes the demo tenant carries on purpose (design review 2026-10-03, F). */
  dq: { manualLateEntry: boolean; otherPipeline: boolean; noDealValue: boolean };
}

function nameFor(i: number): { firstName: string; lastName: string } {
  return { firstName: FIRST[(i * 7 + Math.floor(random() * 5)) % FIRST.length], lastName: LAST[(i * 11 + Math.floor(random() * 3)) % LAST.length] };
}

function phoneFor(): string {
  const area = 200 + Math.floor(random() * 700);
  const rest = String(Math.floor(1000000 + random() * 8999999)).padStart(7, '0');
  return `+1${area}${rest}`;
}

/** Weekly applied volume curve — dips early July, pushes through August. */
function weekMultiplier(weekIndex: number): number {
  const curve = [0.95, 1.0, 0.85, 0.6, 0.7, 0.9, 1.05, 1.15, 1.35, 1.25, 1.45, 1.3, 1.4, 1.2];
  return curve[Math.min(weekIndex, curve.length - 1)];
}

function generateLeads(now: Date, today: string): Lead[] {
  const leads: Lead[] = [];
  const firstSunday = weekStart(START_DATE);
  const weeks: string[] = [];
  for (let w = firstSunday; w <= today; w = addDays(w, 7)) weeks.push(w);

  const rawWeights = weeks.map((w, idx) => {
    const end = weekEnd(w);
    // Partial current week: scale by elapsed days.
    const elapsed = end > today ? (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${w}T12:00:00Z`)) / DAY + 1 : 7;
    return weekMultiplier(idx) * (elapsed / 7);
  });
  const total = rawWeights.reduce((s, x) => s + x, 0);
  const target = 196; // + 4 fresh applicants added below ≈ 200

  let i = 0;
  for (const [idx, w] of weeks.entries()) {
    const count = Math.max(1, Math.round((rawWeights[idx] / total) * target));
    const wStart = Date.parse(`${w}T04:00:00Z`);
    const wEndCap = Math.min(Date.parse(`${addDays(w, 7)}T04:00:00Z`), now.getTime() - 3 * DAY);
    if (wEndCap <= wStart) continue;
    for (let k = 0; k < count; k += 1) {
      const appliedAt = new Date(wStart + random() * (wEndCap - wStart));
      leads.push(buildJourney(i, appliedAt, pickSource(), now));
      i += 1;
    }
  }

  // Fresh applicants for the daily to-do (Day-1 and Day-3 buckets): applied,
  // no consult booked.
  for (const daysAgo of [1, 1, 3, 3]) {
    const d = addDays(today, -daysAgo);
    const at = new Date(Date.parse(`${d}T15:00:00Z`) + random() * 4 * 3_600_000);
    const lead = buildJourney(i, at, pickSource(), now, { forceApplied: true });
    leads.push(lead);
    i += 1;
  }
  applyDataQualityClasses(leads, now, today);
  return leads;
}

/**
 * The demo tenant carries every known data-quality class, deterministically, so replays and the acceptance
 * tests exercise real failures (design review 2026-10-03, F):
 *   - manual entries into a late stage (class C): a non-form contact whose first observed stage is past Applied;
 *   - a form applicant routed to the unfollowed Nurture pipeline (class X);
 *   - new clients with no deal value (the partial-data rule on LTV:CAC);
 *   - consult attendance recorded for < 90 % of one past week (the show rate is withheld there);
 *   - CAD + USD payments, a full and a partial refund, a failed charge retried and later paid (payments, below);
 *   - a maturing week: `history_complete_since` sits inside the seeded window (settings, below).
 */
function applyDataQualityClasses(leads: Lead[], now: Date, today: string): void {
  // Class C — every 23rd lead that got past Applied: entered by hand at its first later stage.
  for (const l of leads) {
    if (l.i % 23 === 7 && l.path.length >= 2 && l.path[0].stageId === STAGE.applied) {
      l.path = l.path.slice(1);
      l.appliedAt = l.path[0].at;
      l.def = { ...l.def, source: 'Manual', utmSource: null, utmMedium: null, campaign: null };
      l.dq.manualLateEntry = true;
    }
  }
  // Class X — three form applicants of the last two complete weeks sit in the Nurture pipeline, Applied only.
  const twoWeeksAgo = addDays(weekStart(today), -14);
  const lastTwoWeeks = leads.filter((l) => localDate(l.appliedAt, TZ) >= twoWeeksAgo && localDate(l.appliedAt, TZ) < weekStart(today) && !l.dq.manualLateEntry);
  let x = 0;
  for (const [n, l] of lastTwoWeeks.entries()) {
    if (x >= 3) break;
    if (n % 4 === 1) {
      l.path = [l.path[0]];
      l.appts = [];
      l.finalStage = STAGE.applied;
      l.status = 'open';
      l.enrolledAt = null;
      l.dq.otherPipeline = true;
      x += 1;
    }
  }
  // Missing deal values — every 7th enrolled client (by index among enrollments) has none on the opportunity.
  leads.filter((l) => l.enrolledAt).forEach((l, n) => {
    if (n % 7 === 3) l.dq.noDealValue = true;
  });
  // Attendance coverage below 90 % — in the complete week three weeks back, a third of the consults that happened have no recorded outcome.
  const w = addDays(weekStart(today), -21);
  const wEnd = weekEnd(w);
  for (const l of leads) {
    for (const a of l.appts) {
      if (a.type !== 'Consult' || a.at.getTime() > now.getTime()) continue;
      const d = localDate(a.at, TZ);
      if (d >= w && d <= wEnd && (a.status === 'showed' || a.status === 'noshow') && l.i % 3 === 0) a.status = 'confirmed';
    }
  }
}

/** The week whose consult attendance is deliberately under-recorded (for the tests). */
export function demoUnderRecordedWeek(today: string): { start: string; end: string } {
  const w = addDays(weekStart(today), -21);
  return { start: w, end: weekEnd(w) };
}

function buildJourney(i: number, appliedAt: Date, def: SourceDef, now: Date, opts: { forceApplied?: boolean } = {}): Lead {
  const { firstName, lastName } = nameFor(i);
  const email = `${firstName}.${lastName}${i}@example.com`.toLowerCase();
  const lead: Lead = {
    i,
    firstName,
    lastName,
    email,
    phone: phoneFor(),
    def,
    owner: pick(OWNERS),
    appliedAt,
    path: [{ stageId: STAGE.applied, at: appliedAt }],
    appts: [],
    recovered: false,
    finalStage: STAGE.applied,
    status: 'open',
    enrolledAt: null,
    dq: { manualLateEntry: false, otherPipeline: false, noDealValue: false },
  };
  if (opts.forceApplied) return lead;

  const future = (d: Date) => d.getTime() > now.getTime();
  let seq = 0;

  // --- Consult booking
  if (!chance(def.pBook)) return lead;
  const bookedAt = new Date(appliedAt.getTime() + between(0.2, 2) * DAY);
  if (future(bookedAt)) return lead;
  lead.path.push({ stageId: STAGE.consultBooked, at: bookedAt });
  lead.finalStage = STAGE.consultBooked;

  let consultAt = new Date(bookedAt.getTime() + between(1, 4) * DAY);
  consultAt = businessHour(consultAt);
  if (future(consultAt)) {
    lead.appts.push({ type: 'Consult', at: consultAt, status: 'confirmed', seq: seq++ });
    return lead;
  }

  let showed = chance(def.pShow);
  if (!showed && chance(0.08)) {
    lead.appts.push({ type: 'Consult', at: consultAt, status: 'cancelled', seq: seq++ });
    return lead;
  }
  if (!showed) {
    lead.appts.push({ type: 'Consult', at: consultAt, status: 'noshow', seq: seq++ });
    const noShowAt = new Date(consultAt.getTime() + 3_600_000);
    lead.path.push({ stageId: STAGE.consultNoShow, at: noShowAt });
    lead.finalStage = STAGE.consultNoShow;
    // Recovered no-show: rebooked and showed.
    if (chance(0.38)) {
      const rebookAt = businessHour(new Date(consultAt.getTime() + between(2, 6) * DAY));
      if (future(rebookAt)) {
        lead.appts.push({ type: 'Consult', at: rebookAt, status: 'confirmed', seq: seq++ });
        lead.path.push({ stageId: STAGE.consultBooked, at: new Date(consultAt.getTime() + DAY) });
        lead.finalStage = STAGE.consultBooked;
        return lead;
      }
      lead.appts.push({ type: 'Consult', at: rebookAt, status: 'showed', seq: seq++ });
      lead.path.push({ stageId: STAGE.consultBooked, at: new Date(consultAt.getTime() + DAY) });
      lead.recovered = true;
      showed = true;
      consultAt = rebookAt;
    } else {
      return lead;
    }
  } else {
    lead.appts.push({ type: 'Consult', at: consultAt, status: 'showed', seq: seq++ });
  }

  // --- Roadmap booking (decided in the consult)
  if (!chance(def.pRoadmapBook)) {
    lead.status = chance(0.5) ? 'lost' : 'open';
    return lead;
  }
  const roadmapBookedAt = new Date(consultAt.getTime() + between(0.05, 0.5) * DAY);
  lead.path.push({ stageId: STAGE.roadmapBooked, at: roadmapBookedAt });
  lead.finalStage = STAGE.roadmapBooked;

  const roadmapAt = businessHour(new Date(roadmapBookedAt.getTime() + between(2, 5) * DAY));
  if (future(roadmapAt)) {
    lead.appts.push({ type: 'Roadmap', at: roadmapAt, status: 'confirmed', seq: seq++ });
    return lead;
  }
  if (!chance(def.pRoadmapShow)) {
    lead.appts.push({ type: 'Roadmap', at: roadmapAt, status: 'noshow', seq: seq++ });
    lead.path.push({ stageId: STAGE.roadmapNoShow, at: new Date(roadmapAt.getTime() + 3_600_000) });
    lead.finalStage = STAGE.roadmapNoShow;
    return lead;
  }
  lead.appts.push({ type: 'Roadmap', at: roadmapAt, status: 'showed', seq: seq++ });

  // --- Enrollment
  if (!chance(def.pEnroll)) {
    lead.path.push({ stageId: STAGE.roadmapObjection, at: new Date(roadmapAt.getTime() + 2 * 3_600_000) });
    lead.finalStage = STAGE.roadmapObjection;
    lead.status = chance(0.6) ? 'lost' : 'open';
    return lead;
  }
  const enrolledAt = new Date(roadmapAt.getTime() + between(0.1, 2) * DAY);
  if (future(enrolledAt)) return lead;
  lead.path.push({ stageId: STAGE.enrolled, at: enrolledAt });
  lead.finalStage = STAGE.enrolled;
  lead.status = 'won';
  lead.enrolledAt = enrolledAt;
  return lead;
}

/** Snap an instant to a plausible 9am–6pm ET slot on the same day. */
function businessHour(d: Date): Date {
  const day = localDate(d, TZ);
  const hour = 9 + Math.floor(random() * 9);
  const minute = pick([0, 15, 30, 45]);
  // ET offset: use 13:00Z as a safe midday anchor then shift by hour.
  return new Date(Date.parse(`${day}T${String(hour + 4).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`));
}

// ---------------------------------------------------------------------------
// Insight / narrative content derived from the generated story
// ---------------------------------------------------------------------------

function within(d: Date, start: string, end: string): boolean {
  const l = localDate(d, TZ);
  return l >= start && l <= end;
}

function periodStats(leads: Lead[], spend: SpendRowLite[], start: string, end: string) {
  const applied = leads.filter((l) => within(l.appliedAt, start, end));
  const byKey = (key: string) => applied.filter((l) => l.def.key === key);
  const consults = leads.flatMap((l) => l.appts.filter((a) => a.type === 'Consult' && within(a.at, start, end) && (a.status === 'showed' || a.status === 'noshow')).map((a) => ({ a, l })));
  const showRate = (key?: string) => {
    const rows = key ? consults.filter((x) => x.l.def.key === key) : consults;
    const showed = rows.filter((x) => x.a.status === 'showed').length;
    return rows.length ? showed / rows.length : null;
  };
  const enrolled = leads.filter((l) => l.enrolledAt && within(l.enrolledAt, start, end));
  const spendFor = (campaignId: string) => spend.filter((s) => s.campaignId === campaignId && s.date >= start && s.date <= end).reduce((t, s) => t + s.spendCents, 0);
  const cpl = (campaignId: string, key: string) => {
    const n = byKey(key).length;
    const c = spendFor(campaignId);
    return n > 0 ? Math.round(c / n) : null;
  };
  return {
    applied: applied.length,
    broad: byKey('broad').length,
    retarget: byKey('retarget').length,
    referral: byKey('referral').length,
    consultsDecided: consults.length,
    showRateAll: showRate(),
    showRateBroad: showRate('broad'),
    showRateRetarget: showRate('retarget'),
    noShowsRetarget: consults.filter((x) => x.l.def.key === 'retarget' && x.a.status === 'noshow').length,
    noShowsAll: consults.filter((x) => x.a.status === 'noshow').length,
    enrolled: enrolled.length,
    referralEnrolled: enrolled.filter((l) => l.def.key === 'referral').length,
    spendCents: spend.filter((s) => s.date >= start && s.date <= end).reduce((t, s) => t + s.spendCents, 0),
    cplBroad: cpl('demo-fb-broad', 'broad'),
    cplRetarget: cpl('demo-fb-retarget', 'retarget'),
  };
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
const usd = (cents: number | null) => (cents === null ? '—' : `$${Math.round(cents / 100).toLocaleString('en-US')}`);

interface SpendRowLite {
  campaignId: string;
  date: string;
  spendCents: number;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

async function chunkInsert<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, size = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export interface DemoSeedSummary {
  contacts: number;
  enrolled: number;
  recoveredNoShows: number;
  appointments: number;
  transitions: number;
  payments: number;
  spendRows: number;
  aiReports: number;
  emailDigests: number;
  syncRuns: number;
}

export async function seedDemo(options: { log?: (line: string) => void } = {}): Promise<DemoSeedSummary> {
  const log = options.log ?? (() => {});
  rng = makeRandom(SEED); // same story every run → idempotent
  await runMigrations();
  const removed = await clearDemoData();
  log(`  cleared previous demo rows: ${removed.contactsRemoved} contacts, ${removed.appointmentsRemoved} appointments, ${removed.paymentsRemoved} payments`);

  TZ = await getTimezone();
  const now = new Date();
  const today = todayInTimezone(TZ, now);
  const prov = { source: 'demo', origin: 'demo', syncedAt: now, backfilled: false } as const;

  // ---- Pipeline + stages ---------------------------------------------------
  await db.insert(pipelines).values([{ ...PIPELINE, position: 0, isTracked: true, ...prov }, { ...NURTURE, position: 1, isTracked: false, ...prov }]);
  const roleOf = new Map<string, SemanticRole | null>();
  const stageRows = Object.values(STAGE).map((id, i) => {
    const suggestion = suggestRole(STAGE_NAMES[id]);
    const role = suggestion.confident ? suggestion.role : null;
    roleOf.set(id, role);
    return {
      id,
      pipelineId: PIPELINE.id,
      name: STAGE_NAMES[id],
      position: i,
      semanticRole: role,
      roleSource: role ? 'auto' : 'unmapped',
      roleConfidence: suggestion.confidence,
      suggestedRole: suggestion.role,
      ...prov,
    };
  });
  await db.insert(stages).values([...stageRows, { id: NURTURE_STAGE, pipelineId: NURTURE.id, name: 'New Lead', position: 0, semanticRole: null, roleSource: 'unmapped', roleConfidence: 0, suggestedRole: null, ...prov }]);

  // ---- Leads ---------------------------------------------------------------
  const leads = generateLeads(now, today);
  const pipelineOf = (l: Lead) => (l.dq.otherPipeline ? NURTURE.id : PIPELINE.id);
  const stageOf = (l: Lead) => (l.dq.otherPipeline ? NURTURE_STAGE : l.finalStage);
  const valueOf = (l: Lead) => (l.dq.noDealValue ? 0 : l.finalStage === STAGE.enrolled ? 299_900 : l.path.length > 2 ? 299_900 : 0);
  /** The contact source as the application forms write it ("Fit Physician Application (Facebook)") — a manual entry says so. */
  const sourceOf = (l: Lead) => (l.dq.manualLateEntry ? 'Manual' : `Fit Physician Application (${l.def.source})`);
  const contactRows = leads.map((l) => ({
    id: `demo-contact-${l.i}`,
    ghlContactId: `demo-contact-${l.i}`,
    ghlOpportunityId: `demo-opp-${l.i}`,
    pipelineId: pipelineOf(l),
    stageId: stageOf(l),
    opportunityStatus: l.status,
    opportunityName: `${l.firstName} ${l.lastName}`,
    opportunityCreatedAt: l.appliedAt,
    monetaryValueCents: valueOf(l),
    lastStageChangeAt: l.path[l.path.length - 1].at,
    firstName: l.firstName,
    lastName: l.lastName,
    email: l.email,
    phone: l.phone,
    emailNormalized: normalizeEmail(l.email),
    phoneNormalized: normalizePhone(l.phone),
    attributionSource: sourceOf(l),
    utmSource: l.def.utmSource,
    utmMedium: l.def.utmMedium,
    utmCampaign: l.def.campaign,
    utmContent: l.def.campaign ? pick(['video-a', 'video-b', 'carousel', 'static-1']) : null,
    entryFunnel: 'Application 7.10',
    ownerName: l.owner,
    tags: ['demo', l.def.source.toLowerCase()],
    ghlCreatedAt: l.dq.manualLateEntry ? new Date(l.appliedAt.getTime() - 30 * DAY) : l.appliedAt,
    ghlUpdatedAt: l.path[l.path.length - 1].at,
    ...prov,
  }));
  await chunkInsert(contactRows, (c) => db.insert(contacts).values(c));

  // ---- The opportunity mirror, as a real sync writes it (the engine dates Applied from here) ----
  const oppRows = leads.map((l) => ({
    id: `demo-opp-${l.i}`,
    ghlContactId: `demo-contact-${l.i}`,
    contactId: `demo-contact-${l.i}`,
    pipelineId: pipelineOf(l),
    stageId: stageOf(l),
    status: l.status,
    name: `${l.firstName} ${l.lastName}`,
    monetaryValueCents: valueOf(l),
    ghlCreatedAt: l.appliedAt,
    ghlUpdatedAt: l.path[l.path.length - 1].at,
    lastStageChangeAt: l.path[l.path.length - 1].at,
    ...prov,
  }));
  await chunkInsert(oppRows, (c) => db.insert(ghlOpportunities).values(c));

  // ---- Transitions ---------------------------------------------------------
  const transitionRows = leads.flatMap((l) =>
    l.path.map((step, s) => ({
      contactId: `demo-contact-${l.i}`,
      ghlOpportunityId: `demo-opp-${l.i}`,
      pipelineId: pipelineOf(l),
      fromStageId: s === 0 ? null : l.path[s - 1].stageId,
      toStageId: l.dq.otherPipeline ? NURTURE_STAGE : step.stageId,
      fromRole: s === 0 ? null : (roleOf.get(l.path[s - 1].stageId) ?? null),
      toRole: l.dq.otherPipeline ? null : (roleOf.get(step.stageId) ?? null),
      observedAt: step.at,
      previousObservedAt: s === 0 ? null : l.path[s - 1].at,
      kind: s === 0 ? 'initial' : 'diff',
      ...prov,
    })),
  );
  await chunkInsert(transitionRows, (c) => db.insert(stageTransitions).values(c));

  // ---- Appointments --------------------------------------------------------
  const appointmentRows = leads.flatMap((l) =>
    l.appts.map((a) => ({
      ghlEventId: `demo-event-${l.i}-${a.seq}`,
      ghlCalendarId: a.type === 'Consult' ? 'demo-calendar-consult' : 'demo-calendar-roadmap',
      calendarName: a.type === 'Consult' ? 'Discovery Consult' : 'Roadmap Session',
      ghlContactId: `demo-contact-${l.i}`,
      contactId: `demo-contact-${l.i}`,
      ghlOpportunityId: `demo-opp-${l.i}`,
      type: a.type,
      title: `${a.type} with ${l.firstName} ${l.lastName}`,
      startTime: a.at,
      endTime: new Date(a.at.getTime() + (a.type === 'Consult' ? 30 : 60) * 60_000),
      timezone: TZ,
      assignedUserId: DEMO_GHL_USER_OF[l.owner] ?? null,
      assignedTo: l.owner,
      ghlStatus: a.status,
      outcome: a.status === 'showed' ? 'showed' : a.status === 'noshow' ? 'no_show' : a.status === 'cancelled' ? 'cancelled' : null,
      ...prov,
    })),
  );
  await chunkInsert(appointmentRows, (c) => db.insert(appointments).values(c));

  // ---- Ad spend (daily, per campaign) --------------------------------------
  const spendLite: SpendRowLite[] = [];
  const spendRows: Array<typeof adSpend.$inferInsert> = [];
  for (let d = START_DATE; d <= today; d = addDays(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    for (const c of CAMPAIGNS) {
      const base = d < '2026-07-15' ? c.dailyBefore : c.dailyAfter;
      const dollars = Math.max(5, jitter(base * (weekend ? 0.8 : 1), 0.15));
      const spendCents = Math.round(dollars * 100);
      const clicks = Math.max(1, Math.round(jitter(dollars / c.cpc, 0.1)));
      const impressions = Math.round(clicks / c.ctr);
      const leadsN = Math.max(0, Math.round(jitter(dollars / c.cpl, 0.35)));
      spendLite.push({ campaignId: c.id, date: d, spendCents });
      spendRows.push({
        platform: c.platform,
        externalId: `demo:${c.id}:${d}`,
        accountId: c.platform === 'meta' ? 'act_demo' : 'demo-customer',
        level: 'campaign',
        campaignId: c.id,
        campaignName: c.name,
        date: d,
        spendCents,
        currency: 'USD',
        impressions,
        clicks,
        leads: leadsN,
        enteredBy: 'demo seed',
        ...prov,
      });
    }
  }
  await chunkInsert(spendRows, (c) => db.insert(adSpend).values(c));

  // ---- Payments ------------------------------------------------------------
  const enrolledLeads = leads.filter((l) => l.enrolledAt).sort((a, b) => a.enrolledAt!.getTime() - b.enrolledAt!.getTime());
  const paymentRows: Array<typeof payments.$inferInsert> = [];
  let payIdx = 0;
  const payment = (l: Lead, extra: Partial<typeof payments.$inferInsert>): typeof payments.$inferInsert => ({
    stripeId: `demo_ch_${String(payIdx++).padStart(4, '0')}`,
    stripeCustomerId: `demo_cus_${l.i}`,
    kind: 'charge',
    status: 'succeeded',
    amountCents: 299_900,
    refundedCents: 0,
    // Like the real account (C1 audit: ~63% CAD): 3 in 5 demo clients pay in CAD.
    currency: l.i % 5 < 3 ? 'CAD' : 'USD',
    email: l.email,
    emailNormalized: normalizeEmail(l.email),
    phoneNormalized: normalizePhone(l.phone),
    contactId: `demo-contact-${l.i}`,
    matchSource: 'auto',
    customerName: `${l.firstName} ${l.lastName}`,
    description: 'Fit Physician Coaching — 12 weeks',
    paidAt: new Date((l.enrolledAt ?? l.path[l.path.length - 1].at).getTime() + between(0.1, 1.5) * DAY),
    metadata: { demo: true },
    ...prov,
    ...extra,
  });

  enrolledLeads.forEach((l, n) => {
    if (n % 5 === 4) {
      // Deposit + invoice pattern.
      paymentRows.push(payment(l, { amountCents: 99_900, description: 'Coaching deposit' }));
      paymentRows.push(payment(l, { kind: 'invoice', amountCents: 200_000, description: 'Coaching balance (invoice)', paidAt: new Date(l.enrolledAt!.getTime() + between(3, 8) * DAY) }));
    } else {
      paymentRows.push(payment(l, {}));
    }
  });
  // One refund (the 3rd enrollment), if present.
  if (enrolledLeads[2]) {
    const row = paymentRows.find((p) => p.contactId === `demo-contact-${enrolledLeads[2].i}`)!;
    row.status = 'refunded';
    row.refundedCents = row.amountCents;
    row.description = `${row.description} (refunded)`;
  }
  // A partial refund (the 6th enrollment): still cash, net of the refund.
  if (enrolledLeads[5]) {
    const row = paymentRows.find((p) => p.contactId === `demo-contact-${enrolledLeads[5].i}` && p.kind === 'charge')!;
    row.refundedCents = 100_000;
    row.description = `${row.description} (partly refunded)`;
  }
  // A failed charge retried and paid the next day (the 7th enrollment): the failures are excluded, the retry is the initial.
  if (enrolledLeads[6]) {
    const l = enrolledLeads[6];
    const paid = paymentRows.find((p) => p.contactId === `demo-contact-${l.i}` && p.kind === 'charge')!;
    const paidAt = paid.paidAt as Date;
    paymentRows.push(payment(l, { status: 'failed', paidAt: null, failedAt: new Date(paidAt.getTime() - 1.2 * DAY), description: 'Fit Physician Coaching — card declined (retried)' }));
    paymentRows.push(payment(l, { status: 'failed', paidAt: null, failedAt: new Date(paidAt.getTime() - 0.6 * DAY), description: 'Fit Physician Coaching — card declined (retried)' }));
  }
  // Three active subscriptions on the most recent enrollments.
  for (const l of enrolledLeads.slice(-3)) {
    paymentRows.push(
      payment(l, {
        kind: 'subscription',
        stripeId: `demo_sub_${l.i}`,
        status: 'active',
        amountCents: 19_900,
        intervalMonths: 1,
        description: 'Ongoing coaching — monthly',
        paidAt: new Date(l.enrolledAt!.getTime() + 14 * DAY),
      }),
    );
  }
  // Two failed charges (roadmap-showed leads whose card declined).
  const objections = leads.filter((l) => l.finalStage === STAGE.roadmapObjection).slice(0, 2);
  for (const l of objections) {
    const at = new Date(l.path[l.path.length - 1].at.getTime() + between(0.2, 1) * DAY);
    paymentRows.push(payment(l, { status: 'failed', paidAt: null, failedAt: at, description: 'Fit Physician Coaching — card declined' }));
  }
  // Two unmatched payments (emails FitFlow has never seen).
  for (const [k, email] of UNMATCHED_CUSTOMERS) {
    paymentRows.push({
      stripeId: `demo_ch_unmatched_${k}`,
      stripeCustomerId: `demo_cus_${k}`,
      kind: 'charge',
      status: 'succeeded',
      amountCents: 299_900,
      refundedCents: 0,
      currency: 'USD',
      email,
      emailNormalized: normalizeEmail(email),
      phoneNormalized: null,
      contactId: null,
      matchSource: null,
      customerName: customerNameOf(email),
      description: 'Fit Physician Coaching — 12 weeks',
      paidAt: new Date(now.getTime() - between(2, 12) * DAY),
      metadata: { demo: true },
      ...prov,
    });
  }
  await chunkInsert(paymentRows, (c) => db.insert(payments).values(c));
  await runPaymentClassification();
  await runAttributionClassification();

  // ---- A maturing week (pure demo tenant only) ----------------------------
  // Stage history is "complete" from six weeks back, so the trailing-8-week baseline always holds maturing weeks and
  // the disclaimer never sunsets on the demo tenant. Never written where real rows exist: those are a tenant's own settings.
  const [{ real }] = await db.select({ real: sql<number>`count(*)` }).from(contacts).where(sql`${contacts.origin} <> 'demo'`);
  if (Number(real) === 0) {
    await setSetting(SETTING_KEYS.historyCompleteSince, addDays(weekStart(today), -42));
    await setSetting(SETTING_KEYS.disclaimerSunset, addDays(today, 120));
  }

  // ---- AI reports (pre-generated, model 'demo') ------------------------------
  const generatedAt = new Date(now.getTime() - 6 * 3_600_000).toISOString();
  const insightRows: Array<typeof aiReports.$inferInsert> = [];
  for (const preset of ['this_week', 'last_week', 'last_30_days'] as const) {
    const range = resolvePreset(preset, today);
    const s = periodStats(leads, spendLite, range.start, range.end);
    const q = `range=${preset}&compare=previous_period`;
    const deepLinks: Record<string, string> = {
      funnel: `/funnel?${q}`,
      ads: `/ads?${q}`,
      command_center: `/?${q}`,
      'stage:consult_showed': `/funnel?${q}&stage=consult_showed`,
      'stage:enrolled': `/funnel?${q}&stage=enrolled`,
      'source:Facebook': '/clients?source=Facebook',
      'source:Referral': '/clients?source=Referral',
    };
    const findings = [
      {
        title: `Retargeting show rate at ${pct(s.showRateRetarget)} vs Broad ${pct(s.showRateBroad)}`,
        detail: `${s.noShowsRetarget} of ${s.noShowsAll} consult no-shows ${range.presetLabel.toLowerCase()} came from Summer Shred — Retargeting, which also pays ${usd(s.cplRetarget)} per lead against ${usd(s.cplBroad)} for Broad.`,
        metric: 'consult_show_rate',
        direction: 'down' as const,
        severity: 'warning' as const,
        link: deepLinks['stage:consult_showed'],
      },
      {
        title: `Broad campaign is the efficient one: ${usd(s.cplBroad)} per lead`,
        detail: `${s.broad} applications from Summer Shred — Broad at ${usd(s.cplBroad)} each; Retargeting delivered ${s.retarget} at ${usd(s.cplRetarget)}. Shifting budget toward Broad lowers cost per client.`,
        metric: 'cost_per_lead',
        direction: 'down' as const,
        severity: 'good' as const,
        link: deepLinks.ads,
      },
      {
        title: `${s.enrolled} enrollments ${range.presetLabel.toLowerCase()}, ${s.referralEnrolled} from referrals`,
        detail: `Referrals were only ${s.referral} of ${s.applied} applications but produced ${s.referralEnrolled} of ${s.enrolled} new clients — the highest applied→client rate of any source.`,
        metric: 'enrollments',
        direction: 'up' as const,
        severity: 'info' as const,
        link: deepLinks['source:Referral'],
      },
    ];
    insightRows.push({
      kind: 'insight',
      periodStart: range.start,
      periodEnd: range.end,
      pipelineId: PIPELINE.id,
      model: 'demo',
      inputHash: `demo:insight:${range.start}:${range.end}`,
      content: {
        findings,
        generatedAt,
        model: 'demo',
        demo: true,
        input: { range: { start: range.start, end: range.end, label: range.resolvedLabel }, stats: s, deepLinks },
      },
    });
  }
  const lastWeek = resolvePreset('last_week', today);
  const lw = periodStats(leads, spendLite, lastWeek.start, lastWeek.end);
  const prevWeek = periodStats(leads, spendLite, addDays(lastWeek.start, -7), addDays(lastWeek.end, -7));
  const paragraph =
    `Last week (${lastWeek.resolvedLabel}) brought ${lw.applied} applications, ${lw.applied >= prevWeek.applied ? 'up' : 'down'} from ${prevWeek.applied} the week before, and ${lw.enrolled} new client${lw.enrolled === 1 ? '' : 's'} against ${usd(lw.spendCents)} of ad spend. ` +
    `Consult show rate landed at ${pct(lw.showRateAll)}; the drag is Summer Shred — Retargeting at ${pct(lw.showRateRetarget)} while Broad held ${pct(lw.showRateBroad)}. ` +
    `Referrals stayed the most reliable path to enrollment. If one thing changes this week, move Retargeting budget to Broad and call the no-shows within a day.`;
  insightRows.push({
    kind: 'weekly_narrative',
    periodStart: lastWeek.start,
    periodEnd: lastWeek.end,
    pipelineId: PIPELINE.id,
    model: 'demo',
    inputHash: `demo:weekly_narrative:${lastWeek.start}`,
    content: { paragraph, generatedAt, model: 'demo', demo: true, input: { range: lastWeek, stats: lw } },
  });
  await db.insert(aiReports).values(insightRows);

  // ---- Email digest history --------------------------------------------------
  const digestRows: Array<typeof emailDigests.$inferInsert> = [];
  const html = (title: string, rows: string[][]) =>
    `<div style="font-family:Inter,Arial,sans-serif;padding:24px;color:#0c0d0e"><p style="font-size:12px;color:#82868d;letter-spacing:.06em;text-transform:uppercase">FitFlow · sample digest</p><h2 style="margin:8px 0 16px">${title}</h2><table style="border-collapse:collapse;font-size:14px">${rows
      .map((r) => `<tr>${r.map((c) => `<td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${c}</td>`).join('')}</tr>`)
      .join('')}</table><p style="margin-top:16px;font-size:12px;color:#82868d">This digest is part of the demo dataset.</p></div>`;

  // Weekly: last 4 Mondays (each covering the prior Sun–Sat week).
  const thisWeekStart = weekStart(today);
  for (let k = 1; k <= 4; k += 1) {
    const pStart = addDays(thisWeekStart, -7 * k);
    const pEnd = addDays(pStart, 6);
    const monday = addDays(pEnd, 2);
    const st = periodStats(leads, spendLite, pStart, pEnd);
    const label = formatRangeLabel(pStart, pEnd);
    digestRows.push({
      kind: 'weekly',
      periodStart: pStart,
      periodEnd: pEnd,
      recipients: ['demo@example.com'],
      subject: `[demo] FitFlow weekly scorecard — ${label} (${st.enrolled} enrolled, ${st.applied} applied)`,
      html: html(`Weekly scorecard · ${label}`, [
        ['Applied', String(st.applied)],
        ['Consults decided', String(st.consultsDecided)],
        ['Consult show rate', pct(st.showRateAll)],
        ['Enrolled', String(st.enrolled)],
        ['Ad spend', usd(st.spendCents)],
        ['Cost per client', st.enrolled ? usd(Math.round(st.spendCents / st.enrolled)) : '—'],
      ]),
      textBody: `Weekly scorecard ${label}: ${st.applied} applied, ${st.enrolled} enrolled, spend ${usd(st.spendCents)}.`,
      status: k === 1 ? 'stored' : 'sent',
      resendId: k === 1 ? null : `demo_re_${k}`,
      sentAt: k === 1 ? null : new Date(`${monday}T11:00:00Z`),
      createdAt: new Date(`${monday}T11:00:00Z`),
    });
  }
  // Daily to-do: last 10 days.
  for (let k = 1; k <= 10; k += 1) {
    const day = addDays(today, -k);
    const yesterday = addDays(day, -1);
    const names = leads.filter((l) => localDate(l.appliedAt, TZ) === yesterday && l.path.length === 1).map((l) => `${l.firstName} ${l.lastName}`);
    const noShows = leads
      .filter((l) => l.appts.some((a) => a.status === 'noshow' && localDate(a.at, TZ) === yesterday))
      .map((l) => `${l.firstName} ${l.lastName}`);
    const total = names.length + noShows.length;
    digestRows.push({
      kind: 'daily_todo',
      periodStart: day,
      periodEnd: day,
      recipients: ['demo@example.com'],
      subject: `[demo] FitFlow to-do — ${formatRangeLabel(day, day)} (${total} to call)`,
      html: html(`Daily to-do · ${formatRangeLabel(day, day)}`, [
        ['Applied, no consult booked (Day-1)', names.join(', ') || '—'],
        ['Consult no-show (Day-1)', noShows.join(', ') || '—'],
      ]),
      textBody: `To-do ${day}: ${total} to call.`,
      status: total === 0 ? 'skipped_empty' : 'sent',
      resendId: total === 0 ? null : `demo_re_daily_${k}`,
      sentAt: total === 0 ? null : new Date(`${day}T11:00:00Z`),
      createdAt: new Date(`${day}T11:00:00Z`),
    });
  }
  // Monthly for July (sent Aug 1) when the story covers it.
  if (today >= '2026-08-01') {
    const st = periodStats(leads, spendLite, '2026-07-01', '2026-07-31');
    digestRows.push({
      kind: 'monthly',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      recipients: ['demo@example.com'],
      subject: `[demo] FitFlow monthly scorecard — July 2026 (${st.enrolled} enrolled)`,
      html: html('Monthly scorecard · July 2026', [
        ['Applied', String(st.applied)],
        ['Consult show rate', pct(st.showRateAll)],
        ['Enrolled', String(st.enrolled)],
        ['Ad spend', usd(st.spendCents)],
      ]),
      textBody: `July 2026: ${st.applied} applied, ${st.enrolled} enrolled.`,
      status: 'sent',
      resendId: 'demo_re_monthly_jul',
      sentAt: new Date('2026-08-01T11:00:00Z'),
      createdAt: new Date('2026-08-01T11:00:00Z'),
    });
  }
  await chunkInsert(digestRows, (c) => db.insert(emailDigests).values(c));

  // ---- Companion login (stage 1): one onboarding user whose day is the demo appointments ------------
  await db.delete(appUsers).where(sql`lower(${appUsers.email}) = ${DEMO_COMPANION_USER.email}`);
  await db.insert(appUsers).values({ name: DEMO_COMPANION_USER.name, email: DEMO_COMPANION_USER.email, role: 'onboarding', passwordHash: hashPassword(DEMO_COMPANION_USER.password), ghlUserId: DEMO_COMPANION_USER.ghlUserId });

  // ---- Sync runs (history for the Sync health panel) -------------------------
  const runRows: Array<typeof syncRuns.$inferInsert> = [];
  for (let k = 1; k <= 6; k += 1) {
    const startedAt = new Date(now.getTime() - k * 3_600_000 * 4);
    runRows.push({
      kind: 'ghl_delta',
      trigger: 'demo',
      status: 'succeeded',
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 12_000 + k * 1_500),
      since: new Date(startedAt.getTime() - 4 * 3_600_000),
      requestsUsed: 6 + k,
      stats: { pipelines: 1, stages: 7, opportunities: leads.length, contactsFetched: 2 + k, contactsUpserted: 2 + k, transitions: k % 3, calendars: 2, appointmentsUpserted: 3 + k, rejectedRows: 0 },
      warnings: [],
    });
  }
  await db.insert(syncRuns).values(runRows);

  const summary: DemoSeedSummary = {
    contacts: contactRows.length,
    enrolled: enrolledLeads.length,
    recoveredNoShows: leads.filter((l) => l.recovered).length,
    appointments: appointmentRows.length,
    transitions: transitionRows.length,
    payments: paymentRows.length,
    spendRows: spendRows.length,
    aiReports: insightRows.length,
    emailDigests: digestRows.length,
    syncRuns: runRows.length,
  };
  log(
    `✓ Demo seeded: ${summary.contacts} contacts (${summary.enrolled} enrolled, ${summary.recoveredNoShows} recovered no-shows), ${summary.appointments} appointments, ${summary.transitions} transitions, ${summary.payments} payments, ${summary.spendRows} spend rows, ${summary.aiReports} AI reports, ${summary.emailDigests} digests, ${summary.syncRuns} sync runs.`,
  );
  return summary;
}

// Keep the module side-effect free for tests; run only as a CLI.
if (require.main === module) {
  // Touch sql so the import is not tree-shaken by tsx when unused in a branch.
  void sql;
  seedDemo({ log: console.log })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('✗ Demo seed failed:', err);
      process.exit(1);
    });
}
