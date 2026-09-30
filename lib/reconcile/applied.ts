/**
 * Applied reconciliation — the pure classifier (docs/plan-reconciliation-2026-09-30.md, item 1).
 *
 * One class per opportunity from the FACTS the engine already derives (lib/metrics/load.ts emits
 * them on each ContactRow; lib/reconcile/appliedLedger.ts adds the rows the engine cannot count).
 * The classes are the ones docs/applied-reconciliation-2026-09-20.md used, plus P / S / unresolved:
 *
 *   A1  position · followed · form source · contact created within 1 day of the opportunity
 *   A2  position · followed · form source · pre-existing contact · first observed stage = applied
 *   U   position · followed · form source · pre-existing · first stage not observed (A2 or A3 unknown)
 *   A3  position · followed · form source · pre-existing · first observed stage later than applied
 *   C   position · followed · non-form source · first stage later than applied (a manual entry)
 *   D   position · followed · non-form source · first stage = applied / unobserved
 *   M   position · followed · moved in from another pipeline (dated by entry)
 *   P   position · followed · contact parked (first observed stage previous_lead)
 *   S   followed · NOT the contact's position (a second opportunity; the engine dates by the held one)
 *   X   unfollowed pipeline · form source
 *   XN  unfollowed pipeline · non-form source
 *   unresolved  the contact row is not mirrored yet (the weekly pass)
 *
 * `applicationSignal` (lib/metrics/index.ts) is untouched: `form` ⇔ class ∈ {A1, A2, U} on the same
 * facts (tests/reconcile-applied.test.ts proves it). Never a silent class: an unknown role throws.
 */

import { SEMANTIC_ROLES } from '@/db/schema';
import { isApplicationFormSource } from '../metrics';

export type ApplicationClass = 'A1' | 'A2' | 'U' | 'A3' | 'C' | 'D' | 'M' | 'P' | 'S' | 'X' | 'XN' | 'unresolved';
export const APPLICATION_CLASSES: readonly ApplicationClass[] = ['A1', 'A2', 'U', 'A3', 'C', 'D', 'M', 'P', 'S', 'X', 'XN', 'unresolved'];

export const CLASS_LABELS: Record<ApplicationClass, string> = {
  A1: 'New form applicant',
  A2: 'Returning form applicant (entered at Applied)',
  U: 'Form applicant, first stage not observed',
  A3: 'Pre-existing form contact entered at a later stage',
  C: 'Manual entry into a later stage (non-form contact)',
  D: 'Non-form contact entered at Applied',
  M: 'Moved in from another pipeline',
  P: 'Parked (previous lead)',
  S: 'Second opportunity of a counted contact',
  X: 'Form applicant in an unfollowed pipeline',
  XN: 'Non-form contact in an unfollowed pipeline',
  unresolved: 'Contact not mirrored yet',
};

export interface ApplicationFacts {
  /** The opportunity's pipeline is followed NOW (pipelines.is_tracked). */
  pipelineFollowed: boolean;
  /** This opportunity is the contact's position (contacts.ghl_opportunity_id). */
  holdsPosition: boolean;
  /** The contact row exists in the mirror. */
  contactMirrored: boolean;
  source: string | null;
  contactCreatedOn: string | null;
  opportunityCreatedOn: string | null;
  /** Resolved role of the first observed transition; null when none was observed. */
  firstStageRole: string | null;
  movedInOn: string | null;
  /** The contact's first observed stage (any opportunity) was previous_lead — the engine excludes them. */
  parked: boolean;
  /** contacts.ghl_created_at equals the opportunity's creation to the second (the contact fetch may have failed). */
  contactCreatedEqualsOpportunity?: boolean;
}

export interface Classification {
  class: ApplicationClass;
  reason: string;
  formSource: boolean;
  /** An A1 whose contact date may have been copied from the opportunity — counted, never hidden. */
  contactDateUnverified: boolean;
}

const DAY_MS = 86_400_000;

function assertRole(role: string | null): void {
  if (role !== null && !(SEMANTIC_ROLES as readonly string[]).includes(role)) throw new Error(`classifyApplication: unknown stage role "${role}"`);
}

export function classifyApplication(f: ApplicationFacts): Classification {
  if (typeof f.pipelineFollowed !== 'boolean') throw new Error('classifyApplication: pipelineFollowed must be known');
  assertRole(f.firstStageRole);
  const formSource = isApplicationFormSource(f.source);
  const srcText = f.source ? `"${f.source}"` : 'empty';
  const out = (cls: ApplicationClass, reason: string, contactDateUnverified = false): Classification => ({ class: cls, reason, formSource, contactDateUnverified });

  if (!f.contactMirrored) return out('unresolved', 'contact not mirrored yet (the weekly pass reads unfollowed pipelines)');
  if (!f.pipelineFollowed) return formSource ? out('X', `form source ${srcText}, opportunity in an unfollowed pipeline`) : out('XN', `contact source is ${srcText}, opportunity in an unfollowed pipeline`);
  if (f.parked) return out('P', 'contact parked — first observed stage was previous lead');
  if (!f.holdsPosition) return out('S', "a second opportunity — the contact's position is held by another one");
  if (f.movedInOn) return out('M', `opportunity moved in from another pipeline on ${f.movedInOn}`);
  const laterStage = f.firstStageRole !== null && f.firstStageRole !== 'applied';
  if (!formSource) return laterStage ? out('C', `contact source is ${srcText}, not an application form; entered directly at ${f.firstStageRole!.replace(/_/g, ' ')}`) : out('D', `contact source is ${srcText}, not an application form; entered at Applied`);
  const newContact = Boolean(f.contactCreatedOn && f.opportunityCreatedOn && Math.abs(Date.parse(f.contactCreatedOn) - Date.parse(f.opportunityCreatedOn)) <= DAY_MS);
  if (newContact) return out('A1', f.contactCreatedEqualsOpportunity ? 'new contact created by the application form (contact date equals the opportunity to the second — unverified)' : 'new contact created by the application form', Boolean(f.contactCreatedEqualsOpportunity));
  if (f.firstStageRole === 'applied') return out('A2', 'returning contact, application entered at Applied');
  if (f.firstStageRole === null) return out('U', 'form-sourced contact; first stage not observed (returning applicant or re-import — unknown)');
  return out('A3', `pre-existing form contact entered directly at ${f.firstStageRole.replace(/_/g, ' ')}`);
}

/** Classes that carry a form signal — the same set `applicationSignal` calls `form`. */
export const FORM_CLASSES: ReadonlySet<ApplicationClass> = new Set(['A1', 'A2', 'U']);
/** Classes the engine counts today that have no application-form record (the caveat's "no form record"). */
export const NO_FORM_RECORD_CLASSES: ReadonlySet<ApplicationClass> = new Set(['A3', 'C', 'D', 'M']);
