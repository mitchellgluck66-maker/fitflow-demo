/**
 * Units are a CONTRACT of every tool result (design review 2026-10-03, A1). A numeric leaf's unit comes
 * from, in order:
 *
 *   1. the `Cents` suffix — money, in the result's currency;
 *   2. a declared `unit` on the object (or the nearest ancestor) for the GENERIC value keys
 *      (value, current, previous, against, abs, baseline, spanValue, previousSpanValue);
 *   3. a generic key inherits its parent's unit when the parent is a named metric (kpis.paidCacCents.current);
 *   4. this catalog, by field name — an explicit list, no regex guessing;
 *   5. otherwise `unknown`: rendered as a plain number, and `tests/analyst-units.test.ts` fails the build
 *      naming the tool and path. Every tool result builder owns its units.
 *
 * `pct` is a 0–1 share read as a percentage; `multiple` a ratio read as "2.1×"; both are the ledger's
 * `ratio` with a `reading`. A delta's `pct` is always a percentage.
 */

/** `fraction` (Oct 7 item 3): a share of two COUNTS — rendered "4 of 8" (the row carries numerator / denominator), "50%" with the `|%` hint. */
export type DeclaredUnit = 'cents' | 'count' | 'pct' | 'multiple' | 'ratio' | 'hours' | 'number' | 'fraction';
export type LedgerUnit = 'cents' | 'ratio' | 'count' | 'number' | 'hours' | 'fraction' | 'unknown';
export type Reading = 'pct' | 'multiple' | null;

export const GENERIC_VALUE_KEYS = /^(value|current|previous|against|abs|baseline|spanValue|previousSpanValue)$/;

/** Field name → unit. Add a line here (or declare `unit` on the object) for every new numeric field. */
export const UNIT_CATALOG: Record<string, DeclaredUnit> = {
  // counts — people, events, rows
  applied: 'count',
  appliedFromMove: 'count',
  applicantsWithoutDate: 'count',
  cancelled: 'count',
  candidate: 'count',
  consultBooked: 'count',
  consultsBooked: 'count',
  roadmapsBooked: 'count',
  count: 'count',
  /** Wave 2 tune-up 2: a bounded name list's "and N more" (tools#peopleList). */
  more: 'count',
  daysInStage: 'count',
  daysWaiting: 'count',
  dropOff: 'count',
  enrolled: 'count',
  enrollments: 'count',
  failedCount: 'count',
  failedLaterPaid: 'count',
  fitflow7: 'count',
  impressions: 'count',
  initialCount: 'count',
  landingPageViews: 'count',
  linkClicks: 'count',
  meta7: 'count',
  noShow: 'count',
  organicEnrollments: 'count',
  otherPipelines: 'count',
  paidEnrollments: 'count',
  past: 'count',
  paymentsInPeriod: 'count',
  platformLeads: 'count',
  previousLeads: 'count',
  purchases: 'count',
  reach: 'count',
  recurringCount: 'count',
  refundCount: 'count',
  sampleExcluded: 'count',
  showed: 'count',
  total: 'count',
  trackedApplied: 'count',
  trackedConsults: 'count',
  trackedEnrolled: 'count',
  trackedRoadmaps: 'count',
  unattributedEnrollments: 'count',
  unattributedInitialCount: 'count',
  unclassifiedCount: 'count',
  undecided: 'count',
  unmatchedCount: 'count',
  unmatchedPayments: 'count',
  unmatchedUtmRows: 'count',
  unresolved: 'count',
  unsupportedMoneyRows: 'count',
  used: 'count',
  withoutFormRecord: 'count',
  activeSubscriptions: 'count',
  enrolledInGhl: 'count',
  paidInStripe: 'count',
  paidUnmatched: 'count',
  weeksUsed: 'count',
  weeksExcluded: 'count',
  oldestAgeMinutes: 'count',
  days: 'count',
  numerator: 'count',
  denominator: 'count',
  // spend gates (Oct 7 item 1)
  trackedEnrollments: 'count',
  weeksWithSpend: 'count',
  weeksInWindow: 'count',
  needsEnrollments: 'count',
  needsWeeks: 'count',
  mayChange: 'count',
  campaigns: 'count',
  // glossary constants as leaves (Oct 7 item 2b)
  showRateMinCoverage: 'pct',
  verdictStrongMultiple: 'multiple',
  verdictWeakMultiple: 'multiple',
  baselineMinWeeks: 'count',
  spendGateMinEnrollments: 'count',
  spendGateMinWeeks: 'count',
  recorded: 'count',
  missingCount: 'count',
  withoutFormRecordCount: 'count',
  otherPipelinesCount: 'count',
  // per-week averages of a baseline (fractional) and the verdict's inputs
  enrollmentsPerWeek: 'number',
  newPayingClientsPerWeek: 'number',
  baselineClientsPerWeek: 'number',
  clients: 'count',
  cashCents: 'cents',
  ratioClients: 'multiple',
  ratioCash: 'multiple',
  // shares (0–1, shown as %)
  appliedToEnrolled: 'pct',
  consultShowRate: 'pct',
  conversionFromPrevious: 'pct',
  coverage: 'pct',
  pct: 'pct',
  rate: 'pct',
  shareOfApplied: 'pct',
  // multiples (shown as ×)
  frequency: 'multiple',
  ltvToCac: 'multiple',
  roas: 'multiple',
  rolling7: 'multiple',
  // plain numbers and identifiers
  fxRate: 'number',
  page: 'number',
  pages: 'number',
  // durations
  timeInStageHours: 'hours',
};

export const DECLARED_UNITS: ReadonlySet<string> = new Set<string>(['cents', 'count', 'pct', 'multiple', 'ratio', 'hours', 'number', 'fraction']);

export function toLedgerUnit(u: DeclaredUnit): LedgerUnit {
  return u === 'pct' || u === 'multiple' || u === 'ratio' ? 'ratio' : u;
}

export function readingOf(u: DeclaredUnit | null): Reading {
  return u === 'pct' ? 'pct' : u === 'multiple' || u === 'ratio' ? 'multiple' : null;
}

export interface ResolvedUnit {
  unit: LedgerUnit;
  reading: Reading;
  /** Which rule decided (for the sweep's message). */
  by: 'suffix' | 'declared' | 'parent' | 'catalog' | 'unknown';
}

const lastKey = (path: string) => (path.split(/[.[]/).filter(Boolean).pop() ?? '').replace(/\]$/, '');
const segments = (path: string) => path.split(/[.[]/).filter(Boolean).map((s) => s.replace(/\]$/, ''));

/** The unit of the leaf at `path`, given the nearest declared unit (null when none). */
export function resolveUnit(path: string, declared: DeclaredUnit | null): ResolvedUnit {
  const key = lastKey(path);
  if (/Cents$/.test(key)) return { unit: 'cents', reading: null, by: 'suffix' };
  if (GENERIC_VALUE_KEYS.test(key)) {
    if (declared) return { unit: toLedgerUnit(declared), reading: readingOf(declared), by: 'declared' };
    // A generic key inherits its parent's unit when the parent is itself a named metric (kpis.paidCacCents.current,
    // kpis.roas.previous); an array index or an unnamed parent gives nothing.
    const segs = segments(path);
    const parent = segs[segs.length - 2];
    if (parent && !/^\d+$/.test(parent)) {
      const p = resolveUnit(`data.${parent}`, null);
      if (p.unit !== 'unknown') return { ...p, by: 'parent' };
    }
    return { unit: 'unknown', reading: null, by: 'unknown' };
  }
  const cat = UNIT_CATALOG[key];
  if (cat) return { unit: toLedgerUnit(cat), reading: readingOf(cat), by: 'catalog' };
  return { unit: 'unknown', reading: null, by: 'unknown' };
}
