/**
 * The Applied classifier (plan item 1) against the people of
 * docs/applied-reconciliation-2026-09-20.md §3, and its parity with the engine's
 * `applicationSignal` (form ⇔ A1 / A2 / U) on the same facts.
 */
import { describe, it, expect } from 'vitest';
import { classifyApplication, FORM_CLASSES, NO_FORM_RECORD_CLASSES, type ApplicationFacts } from '@/lib/reconcile/applied';
import { APPLIED_DEFINITIONS, CANDIDATE_LABEL, LEDGER_VERSION } from '@/lib/reconcile/definitions';
import { applicationSignal, normalizeCampaign } from '@/lib/metrics';
import { METRIC_DEFINITION_VERSION } from '@/lib/metrics/glossary';

const FORM = 'New Application 7.10';
const base: ApplicationFacts = { pipelineFollowed: true, holdsPosition: true, contactMirrored: true, source: FORM, contactCreatedOn: '2026-09-20', opportunityCreatedOn: '2026-09-20', firstStageRole: 'applied', movedInOn: null, parked: false };

/** The doc's week, compressed: [name, contact created, source, first observed role, followed?, moved-in?] → class. */
const WEEK: Array<[string, string, string, string | null, boolean, string | null, string]> = [
  ...['Diana Diaz', 'Mydhili Moorthie', 'Sarah Farquharson', 'Doaa El Rouby', 'Greta Guyer', 'Michelle Farrell', 'Monica Chaddock', 'R Thomas', 'mili kakadiya', 'Janelle Hupp', 'Josephine Perez', 'DeeDee Price', 'Josel doyle', 'Sangeeta Garg', 'Kelly Peesker', 'Roseanna Parkhurst-Gatewood', 'Jenny Ogilvie', 'Tracy Moore', 'Gae Rodke', 'Joanne White', 'Manaal Ameen', 'Sharon Hird', 'amy cole', 'Lynn Murphy', 'Shirley Anne Thomson', 'Annie Kurian'].map((n): [string, string, string, string | null, boolean, string | null, string] => [n, '2026-09-20', FORM, 'applied', true, null, 'A1']),
  ['Simin K', '2026-09-25', 'Fit Physician Application', 'applied', true, null, 'A1'],
  ...['Nicole Coluccio', 'Renee Riggs', 'Jennifer Daniels', 'Teri Miner', 'Allison Haynes', 'Dzovag Minassian'].map((n): [string, string, string, string | null, boolean, string | null, string] => [n, '2026-09-20', FORM, 'consult_booked', true, null, 'A1']),
  ['Alexandra Bunting', '2026-09-24', FORM, 'consult_noshow', true, null, 'A1'],
  ['Heidi Thorson', '2026-09-20', FORM, 'enrolled', true, null, 'A1'],
  ...['Sreyoshi Alam', 'Magalie DUBE', 'Elizabeth Dickens', 'Seema Menon', 'Lori Reed'].map((n): [string, string, string, string | null, boolean, string | null, string] => [n, '2026-09-20', FORM, 'roadmap_booked', true, null, 'A1']),
  ['Marion Raflores', '2025-07-27', FORM, 'roadmap_booked', true, null, 'A3'],
  ['Mireille Desrosiers', '2024-11-25', 'fit physician roadmap workshop', 'enrolled', true, null, 'C'],
  ['Lindsay Ritsma', '2025-05-21', 'longevity & running', 'enrolled', true, null, 'C'],
  ['Jen Clow', '2024-11-25', 'Back To School 2026 Scholarship', 'enrolled', true, null, 'C'],
  ['Paula Edelson', '2025-10-12', '15-Minute Fit Physician Consult', 'roadmap_booked', true, null, 'C'],
  ['Alanna Roberts', '2024-11-25', 'Internal: Roadmap Building Session', 'enrolled', true, null, 'C'],
  ['Catherine Turcot', '2024-11-25', 'longevity & running', 'enrolled', true, null, 'C'],
  ['Sara Rasmussen', '2024-11-25', 'facebook form lead', 'roadmap_booked', true, null, 'C'],
  ['Karan VOLLMANN', '2025-07-03', 'Facebook', 'applied', true, null, 'D'],
  ['Molly O’Connor', '2025-07-31', 'fit physician quiz', 'applied', true, null, 'D'],
  ['Morgan Wimberley', '2024-11-25', 'Facebook', 'applied', true, null, 'D'],
  ['Nuala Broadhead', '2026-05-01', 'Facebook', 'applied', true, '2026-09-22', 'M'],
  ['Erin FitzPatrick', '2026-09-20', 'Fit Physician Application (B)', null, false, null, 'X'],
  ['Suzan Abdel Salam', '2024-11-25', FORM, null, false, null, 'X'],
  ['Lisa Brinn', '2026-09-17', FORM, null, false, null, 'X'],
];

const factsOf = (row: (typeof WEEK)[number]): ApplicationFacts => ({ ...base, contactCreatedOn: row[1], source: row[2], firstStageRole: row[3], pipelineFollowed: row[4], movedInOn: row[5], opportunityCreatedOn: row[0] === 'Simin K' ? '2026-09-25' : row[0] === 'Alexandra Bunting' ? '2026-09-24' : '2026-09-20' });

describe('classifyApplication on the doc\'s week', () => {
  it('gives every person the doc\'s class: A1 40 · A3 1 · C 7 · D 3 · M 1 · X 3', () => {
    const counts: Record<string, number> = {};
    for (const row of WEEK) {
      const c = classifyApplication(factsOf(row));
      expect(c.class, row[0]).toBe(row[6]);
      counts[c.class] = (counts[c.class] ?? 0) + 1;
    }
    expect(counts).toEqual({ A1: 40, A3: 1, C: 7, D: 3, M: 1, X: 3 });
    // The current definition (engine) counts the 52 followed positions; the candidate counts 40 + 3.
    const current = WEEK.filter((r) => r[4]).length;
    const candidate = WEEK.filter((r) => APPLIED_DEFINITIONS.candidate.counts(classifyApplication(factsOf(r)).class)).length;
    expect(current).toBe(52);
    expect(candidate).toBe(43);
  });

  it('the review\'s classes: U, P, S, XN, unresolved; an A1 with a copied contact date is flagged, never hidden', () => {
    expect(classifyApplication({ ...base, contactCreatedOn: '2025-01-01', firstStageRole: null })).toMatchObject({ class: 'U', formSource: true });
    expect(classifyApplication({ ...base, parked: true })).toMatchObject({ class: 'P' });
    expect(classifyApplication({ ...base, holdsPosition: false })).toMatchObject({ class: 'S' });
    expect(classifyApplication({ ...base, pipelineFollowed: false, source: 'Facebook' })).toMatchObject({ class: 'XN' });
    expect(classifyApplication({ ...base, contactMirrored: false, pipelineFollowed: false })).toMatchObject({ class: 'unresolved' });
    const flagged = classifyApplication({ ...base, contactCreatedEqualsOpportunity: true });
    expect(flagged).toMatchObject({ class: 'A1', contactDateUnverified: true });
    expect(flagged.reason).toContain('unverified');
    // Order: unresolved before unfollowed before parked before position before moved-in.
    expect(classifyApplication({ ...base, parked: true, holdsPosition: false }).class).toBe('P');
    expect(classifyApplication({ ...base, holdsPosition: false, movedInOn: '2026-09-22' }).class).toBe('S');
  });

  it('never a silent class: an unknown role throws', () => {
    expect(() => classifyApplication({ ...base, firstStageRole: 'signed_up' })).toThrow(/unknown stage role "signed_up"/);
  });

  it('parity with the engine: applicationSignal says form exactly for A1 / A2 / U on the same facts', () => {
    const cases: ApplicationFacts[] = [
      ...WEEK.map(factsOf).filter((f) => f.pipelineFollowed),
      { ...base, contactCreatedOn: '2025-01-01', firstStageRole: 'applied' }, // A2
      { ...base, contactCreatedOn: '2025-01-01', firstStageRole: null }, // U
      { ...base, contactCreatedOn: '2025-01-01', firstStageRole: 'enrolled' }, // A3
      { ...base, source: null, firstStageRole: null }, // D
      { ...base, source: 'Calendar', firstStageRole: 'consult_booked' }, // C
      { ...base, movedInOn: '2026-09-22' }, // M
    ];
    for (const f of cases) {
      const cls = classifyApplication(f).class;
      const sig = applicationSignal({ source: f.source, contactCreatedOn: f.contactCreatedOn, appliedOn: f.movedInOn ?? f.opportunityCreatedOn, firstStageRole: f.firstStageRole, movedIn: Boolean(f.movedInOn) }).signal;
      expect(sig, `${cls} ${JSON.stringify(f)}`).toBe(FORM_CLASSES.has(cls) ? 'form' : 'none');
    }
    expect([...NO_FORM_RECORD_CLASSES]).toEqual(['A3', 'C', 'D', 'M']);
  });

  it('the registry: current is derived from the engine, the candidate is labelled not in use, the version follows the glossary', () => {
    expect(APPLIED_DEFINITIONS.current.note).toContain('never re-implemented');
    expect(CANDIDATE_LABEL).toBe('candidate — deferred #1, not in use');
    expect(LEDGER_VERSION).toBe(METRIC_DEFINITION_VERSION);
    expect(normalizeCampaign('(Sept 7) Scaling')).toBe('sept 7 scaling');
  });
});
