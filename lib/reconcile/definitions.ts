/**
 * The Applied definitions registry (plan item 1). The ONLY file a DECISION on docs/deferred.md #1
 * touches: the ledger stores facts and classes; the verdicts come from here.
 *
 *   current   — DERIVED FROM THE ENGINE. `verdict_current` is copied from
 *               `membershipFor(input, day, 'period').applied` (lib/metrics/index.ts), never
 *               re-implemented, so the card can never disagree with the tiles (rule 3).
 *   candidate — deferred #1: people who applied through the application form, once per person
 *               per day, including form applicants routed to unfollowed pipelines. NOT IN USE.
 *
 * When the decision lands, `candidate.counts` becomes the engine's rule (lib/metrics/load.ts)
 * and this file's labels flip; the ledger rows do not change.
 */

import { METRIC_DEFINITION_VERSION } from '../metrics/glossary';
import type { ApplicationClass } from './applied';

export const LEDGER_VERSION = METRIC_DEFINITION_VERSION;

export const CANDIDATE_LABEL = 'candidate — deferred #1, not in use';
export const CURRENT_LABEL = 'counted today (current definition)';
export const DEFINITION_UNDER_REVIEW_NOTE = 'Definition of Applied under review — docs/deferred.md #1';

export interface AppliedDefinition {
  key: 'current' | 'candidate';
  label: string;
  note: string;
}

export const APPLIED_DEFINITIONS: { current: AppliedDefinition; candidate: AppliedDefinition & { counts: (cls: ApplicationClass) => boolean } } = {
  current: { key: 'current', label: CURRENT_LABEL, note: 'derived from the engine (membershipFor().applied) — never re-implemented here' },
  candidate: {
    key: 'candidate',
    label: CANDIDATE_LABEL,
    note: 'form applicants, once per person per day, form applicants in unfollowed pipelines included (docs/applied-reconciliation-2026-09-20.md §5)',
    counts: (cls) => cls === 'A1' || cls === 'A2' || cls === 'U' || cls === 'X',
  },
};
