/**
 * Owner profile + dated owner notes (plan item 3, amendment 4).
 *
 * The profile lives in settings (`analyst_owner_profile`, JSON). Notes live in
 * `analyst_notes`: `active` rows reach the brief and `get_notes`; `proposed`
 * rows come from the Analyst's `note_proposals` and NEVER reach a prompt until
 * the owner approves them (then `active`) or rejects them. No tool writes here.
 *
 * Gaps: when gross margin, the monthly target, or offer prices are empty, the
 * metrics that need them are WITHHELD by name — "Withheld until filled: CAC
 * payback, pace to target, funnel-leak $" — in Setup, the brief and get_notes.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, analystNotes } from '@/db';
import { getSetting, setSetting } from '../settings';
import { ANALYST_KEYS } from './config';
import type { Currency } from '../money';

export interface OwnerOffer {
  name: string;
  priceCents: number;
  currency: Currency;
}

export interface OwnerProfile {
  goals: string;
  offers: OwnerOffer[];
  /** 0–100. */
  grossMarginPct: number | null;
  targetCacCents: number | null;
  monthlyRevenueTargetCents: number | null;
  team: string;
  goodWeek: string;
}

export const EMPTY_PROFILE: OwnerProfile = { goals: '', offers: [], grossMarginPct: null, targetCacCents: null, monthlyRevenueTargetCents: null, team: '', goodWeek: '' };

/** Which metric each profile field unlocks (amendment 4). */
export const PROFILE_GAPS: ReadonlyArray<{ field: keyof OwnerProfile; label: string; withheld: string; isEmpty: (p: OwnerProfile) => boolean }> = [
  { field: 'grossMarginPct', label: 'Gross margin', withheld: 'CAC payback', isEmpty: (p) => p.grossMarginPct === null || !(p.grossMarginPct > 0) },
  { field: 'monthlyRevenueTargetCents', label: 'Monthly revenue target', withheld: 'pace to target', isEmpty: (p) => p.monthlyRevenueTargetCents === null || !(p.monthlyRevenueTargetCents > 0) },
  { field: 'offers', label: 'Offer prices', withheld: 'funnel-leak $', isEmpty: (p) => p.offers.length === 0 || p.offers.every((o) => !(o.priceCents > 0)) },
];

export interface ProfileGap {
  field: keyof OwnerProfile;
  label: string;
  withheld: string;
}

/** Pure: the missing fields and the metrics withheld because of them. */
export function profileGaps(profile: OwnerProfile | null): ProfileGap[] {
  const p = profile ?? EMPTY_PROFILE;
  return PROFILE_GAPS.filter((g) => g.isEmpty(p)).map(({ field, label, withheld }) => ({ field, label, withheld }));
}

/** "Withheld until filled: CAC payback, pace to target, funnel-leak $" — or null when nothing is missing. */
export function withheldLine(gaps: ProfileGap[]): string | null {
  return gaps.length ? `Withheld until filled: ${gaps.map((g) => g.withheld).join(', ')}` : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pure: parse the stored JSON defensively; a broken value is an empty profile, never a crash. */
export function parseOwnerProfile(raw: string | null | undefined): OwnerProfile {
  if (!raw) return { ...EMPTY_PROFILE, offers: [] };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const offers = Array.isArray(o.offers)
      ? (o.offers as Array<Record<string, unknown>>)
          .filter((x) => typeof x?.name === 'string' && x.name.trim())
          .map((x) => ({ name: String(x.name).trim(), priceCents: Math.round(num(x.priceCents) ?? 0), currency: x.currency === 'USD' ? ('USD' as const) : ('CAD' as const) }))
      : [];
    return {
      goals: typeof o.goals === 'string' ? o.goals : '',
      offers,
      grossMarginPct: num(o.grossMarginPct),
      targetCacCents: num(o.targetCacCents) === null ? null : Math.round(num(o.targetCacCents)!),
      monthlyRevenueTargetCents: num(o.monthlyRevenueTargetCents) === null ? null : Math.round(num(o.monthlyRevenueTargetCents)!),
      team: typeof o.team === 'string' ? o.team : '',
      goodWeek: typeof o.goodWeek === 'string' ? o.goodWeek : '',
    };
  } catch {
    return { ...EMPTY_PROFILE, offers: [] };
  }
}

export async function getOwnerProfile(): Promise<OwnerProfile> {
  return parseOwnerProfile(await getSetting(ANALYST_KEYS.ownerProfile));
}

export async function saveOwnerProfile(profile: OwnerProfile): Promise<void> {
  await setSetting(ANALYST_KEYS.ownerProfile, JSON.stringify(parseOwnerProfile(JSON.stringify(profile))));
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export type NoteStatus = 'active' | 'proposed' | 'rejected';

export interface NoteRow {
  id: string;
  text: string;
  status: NoteStatus;
  source: 'owner' | 'analyst';
  createdAt: Date;
  decidedAt: Date | null;
  threadId: string | null;
}

function asNote(r: typeof analystNotes.$inferSelect): NoteRow {
  return { id: r.id, text: r.text, status: r.status as NoteStatus, source: r.source as 'owner' | 'analyst', createdAt: r.createdAt, decidedAt: r.decidedAt, threadId: r.threadId };
}

export async function listNotes(status?: NoteStatus): Promise<NoteRow[]> {
  const rows = await db
    .select()
    .from(analystNotes)
    .where(status ? eq(analystNotes.status, status) : undefined)
    .orderBy(desc(analystNotes.createdAt));
  return rows.map(asNote);
}

/** Only ACTIVE notes ever reach a prompt. */
export async function activeNotes(): Promise<NoteRow[]> {
  return listNotes('active');
}

export async function addNote(text: string, opts: { source: 'owner' | 'analyst'; threadId?: string | null; turnId?: string | null }): Promise<NoteRow> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('A note needs text');
  const status: NoteStatus = opts.source === 'owner' ? 'active' : 'proposed';
  const [row] = await db
    .insert(analystNotes)
    .values({ text: trimmed, status, source: opts.source, threadId: opts.threadId ?? null, turnId: opts.turnId ?? null, decidedAt: status === 'active' ? new Date() : null })
    .returning();
  return asNote(row);
}

/** The owner approves (→ active) or rejects a proposed note. Only proposed rows can be decided. */
export async function decideNote(id: string, decision: 'active' | 'rejected'): Promise<NoteRow | null> {
  const [row] = await db
    .update(analystNotes)
    .set({ status: decision, decidedAt: new Date() })
    .where(and(eq(analystNotes.id, id), eq(analystNotes.status, 'proposed')))
    .returning();
  return row ? asNote(row) : null;
}

export async function deleteNote(id: string): Promise<boolean> {
  const rows = await db.delete(analystNotes).where(eq(analystNotes.id, id)).returning({ id: analystNotes.id });
  return rows.length > 0;
}
