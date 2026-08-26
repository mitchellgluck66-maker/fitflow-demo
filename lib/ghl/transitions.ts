/**
 * Stage transition derivation — pure functions.
 *
 * Each sync observes every opportunity's current stage. Comparing that against
 * what we stored last time yields the moves that happened in between. GHL's
 * `lastStageChangeAt` (when present) gives the real instant; otherwise the
 * best we can say is "somewhere between the previous sync and this one", and
 * we record both bounds rather than pretend to know.
 */

import type { SemanticRole } from '@/db/schema';

export interface ObservedOpportunity {
  ghlOpportunityId: string;
  pipelineId: string;
  stageId: string;
  /** ISO string from GHL, if present. */
  lastStageChangeAt?: string | null;
  createdAt?: string | null;
}

export interface StoredPosition {
  contactId: string;
  pipelineId: string | null;
  stageId: string | null;
}

export interface DerivedTransition {
  contactId: string;
  ghlOpportunityId: string;
  pipelineId: string;
  fromStageId: string | null;
  toStageId: string;
  fromRole: SemanticRole | null;
  toRole: SemanticRole | null;
  observedAt: Date;
  previousObservedAt: Date | null;
  kind: 'initial' | 'diff' | 'backfill';
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the transition (if any) for one opportunity.
 *
 * @param observed   what GHL says now
 * @param stored     what we stored after the previous sync (null = never seen)
 * @param roleOf     stage id → semantic role lookup
 * @param now        this sync's timestamp
 * @param previous   previous sync's timestamp (null on the first ever sync)
 * @param backfill   true when importing history rather than observing live
 */
export function deriveTransition(
  observed: ObservedOpportunity,
  stored: StoredPosition | null,
  contactId: string,
  roleOf: (stageId: string | null) => SemanticRole | null,
  now: Date,
  previous: Date | null,
  backfill = false,
): DerivedTransition | null {
  const changedAt = parseDate(observed.lastStageChangeAt);

  // First sighting: record where they are, anchored to the best-known time.
  if (!stored || (stored.stageId === null && stored.pipelineId === null)) {
    const createdAt = parseDate(observed.createdAt);
    return {
      contactId,
      ghlOpportunityId: observed.ghlOpportunityId,
      pipelineId: observed.pipelineId,
      fromStageId: null,
      toStageId: observed.stageId,
      fromRole: null,
      toRole: roleOf(observed.stageId),
      observedAt: changedAt ?? createdAt ?? now,
      previousObservedAt: null,
      kind: backfill ? 'backfill' : 'initial',
    };
  }

  if (stored.stageId === observed.stageId && stored.pipelineId === observed.pipelineId) {
    return null;
  }

  // Moved. If GHL tells us when, trust it — but never earlier than the previous
  // sync, which already saw the OLD stage (clock skew / stale field).
  let observedAt = now;
  if (changedAt && (!previous || changedAt > previous)) observedAt = changedAt;

  return {
    contactId,
    ghlOpportunityId: observed.ghlOpportunityId,
    pipelineId: observed.pipelineId,
    fromStageId: stored.stageId,
    toStageId: observed.stageId,
    fromRole: roleOf(stored.stageId),
    toRole: roleOf(observed.stageId),
    observedAt,
    previousObservedAt: previous,
    kind: backfill ? 'backfill' : 'diff',
  };
}

/** Map GHL's appointmentStatus onto the read-only outcome column. */
export function outcomeFromGhlStatus(status: string | null | undefined): string | null {
  switch (status) {
    case 'showed':
      return 'showed';
    case 'noshow':
      return 'no_show';
    case 'cancelled':
    case 'invalid':
      return 'cancelled';
    default:
      return null;
  }
}

/** Lower-cased, trimmed email for identity joins. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

/** Digits only, with a leading US country code when it looks like a 10-digit number. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `1${digits}`;
  return digits;
}
