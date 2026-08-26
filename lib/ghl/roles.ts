/**
 * Stage name → semantic role mapper.
 *
 * Miranda's pipeline stages are read live from GHL and may be renamed or added
 * at any time. The metrics engine never looks at stage NAMES — only at the
 * semantic role each stage has been assigned. This module makes the first
 * guess; a human confirms anything it is not confident about (Setup page).
 *
 * Conservative by design: below AUTO_THRESHOLD the stage is left `unmapped`
 * and surfaced in sync-health rather than silently bucketed. A wrong role
 * corrupts every funnel number downstream.
 */

import { SEMANTIC_ROLES, type SemanticRole } from '@/db/schema';

export { SEMANTIC_ROLES };
export type { SemanticRole };

export const ROLE_LABELS: Record<SemanticRole, string> = {
  applied: 'Applied',
  consult_booked: 'Consult booked',
  consult_noshow: 'Consult no-show',
  roadmap_booked: 'Roadmap booked',
  roadmap_showed: 'Roadmap showed',
  enrolled: 'Enrolled',
  other: 'Other (excluded from funnel)',
};

/** Funnel order used for display and stage→stage conversion. */
export const FUNNEL_ROLE_ORDER: SemanticRole[] = [
  'applied',
  'consult_booked',
  'roadmap_booked',
  'roadmap_showed',
  'enrolled',
];

/** Known spellings per role. Order matters only for tie-breaks. */
const ROLE_ALIASES: Record<Exclude<SemanticRole, 'other'>, string[]> = {
  applied: ['Applied', 'Application', 'Application Received', 'New Lead', 'New Application'],
  consult_booked: [
    'Consult Booked',
    'Consultation Booked',
    'Consult Scheduled',
    'Discovery Call Booked',
    'Intro Call Booked',
  ],
  consult_noshow: ['Consult No Show', 'Consultation No Show', 'Consult No-Show', 'Discovery No Show'],
  roadmap_booked: ['Pre-Roadmap Booked', 'Roadmap Booked', 'Roadmap Scheduled', 'Strategy Session Booked'],
  roadmap_showed: [
    'Roadmap Showed',
    'Roadmap Completed',
    'Roadmap Attended',
    'Roadmap Completed: Objection',
    'Roadmap Done',
  ],
  enrolled: ['Enrolled', 'Closed Won', 'Won', 'Client', 'Signed'],
};

/** Below this the mapper does not commit; the stage is surfaced for review. */
export const AUTO_THRESHOLD = 0.8;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/no-show/g, 'noshow')
      .replace(/no show/g, 'noshow')
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/**
 * Score how well two stage names match. Exact → 1; substantial containment →
 * 0.85; else token overlap over the longer token set. Returns 0..1.
 */
export function similarity(a: string, b: string): number {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Containment only counts when the shorter name is most of the longer one:
  // "Consult Booked" ⊂ "Consult Booked (Rescheduled)" yes; "Lead" ⊂
  // "Previous Leads" no — a four-letter substring is not evidence.
  const shorter = Math.min(na.length, nb.length);
  const longer = Math.max(na.length, nb.length);
  if ((na.includes(nb) || nb.includes(na)) && shorter / longer >= 0.6) return 0.85;

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

export interface RoleSuggestion {
  role: SemanticRole;
  confidence: number;
  /** True when confidence ≥ AUTO_THRESHOLD and the mapper would apply it. */
  confident: boolean;
  matchedAlias: string | null;
}

/** Best-guess semantic role for a GHL stage name. */
export function suggestRole(stageName: string): RoleSuggestion {
  let best: { role: SemanticRole; score: number; alias: string | null } = {
    role: 'other',
    score: 0,
    alias: null,
  };

  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as Array<
    [Exclude<SemanticRole, 'other'>, string[]]
  >) {
    for (const alias of aliases) {
      const score = similarity(stageName, alias);
      if (score > best.score) best = { role, score, alias };
    }
  }

  // Guard against a partial-token match promoting the wrong direction:
  // "Roadmap No Show" overlaps "Roadmap Booked" on one token but is NOT a
  // booking. A no-show name never maps to a booked/showed role automatically.
  const isNoShow = tokens(stageName).has('noshow');
  if (isNoShow && best.role !== 'consult_noshow') {
    best = { ...best, score: Math.min(best.score, AUTO_THRESHOLD - 0.01) };
  }

  const confidence = Math.round(best.score * 100) / 100;
  return {
    role: best.role,
    confidence,
    confident: confidence >= AUTO_THRESHOLD,
    matchedAlias: best.alias,
  };
}

export function isSemanticRole(value: unknown): value is SemanticRole {
  return typeof value === 'string' && (SEMANTIC_ROLES as readonly string[]).includes(value);
}
