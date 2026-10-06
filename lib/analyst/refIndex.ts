/**
 * The ref index (2026-10-06, item 2): every tool result carries `refs` — one line per citeable leaf, the exact
 * token to copy — so the model never composes a path ("Paid CAC (current) → {r2:data.kpis.paidCacCents.current}").
 * Built from the same ledger walk the verifier uses, so a token in the index always resolves. Labels come from the
 * glossary and a small key table; an array row is named by its name / campaign / label / key / kpi / from→to.
 * Kept OUTSIDE `data` (the ledger walks `data` only), so the index is never indexed. PURE.
 */

import { ledgerEntries, type LedgerEntry } from './ledger';
import { GLOSSARY } from '../metrics/glossary';
import { metricKeyOfKpi } from '../metrics/maturity';

const GLOSSARY_LABELS = new Map(GLOSSARY.map((e) => [e.key, e.label]));

/** Field names that are not glossary keys, as the owner reads them. */
const KEY_LABELS: Record<string, string> = {
  current: 'current',
  previous: 'previous',
  against: 'against',
  abs: 'change',
  pct: 'change %',
  value: 'value',
  spanValue: 'window total',
  previousSpanValue: 'previous window total',
  spendCents: 'Spend',
  initialCents: 'Initial cash',
  paidInitialCents: 'Paid-attributed initial cash',
  organicInitialCents: 'Organic initial cash',
  unattributedInitialCents: 'Unattributed initial cash',
  recurringCents: 'Recurring cash',
  collectedCents: 'Cash collected',
  refundedCents: 'Refunds',
  failedCents: 'Failed charges',
  mrrCents: 'MRR',
  contractValueCents: 'Contract value',
  costPerRoadmapCents: 'Cost per roadmap booked',
  costPerLeadCents: 'Cost per lead',
  costPerConsultCents: 'Cost per consult',
  costPerClientCents: 'Cost per client',
  costPerAppliedCents: 'Cost per applied',
  costPerCents: 'Cost per',
  cpmCents: 'CPM',
  cpcCents: 'CPC',
  paidCacCents: 'Paid CAC',
  blendedCacCents: 'Blended CAC',
  cacCents: 'Blended CAC',
  roas: 'ROAS',
  ltvToCac: 'LTV:CAC',
  enrollments: 'Enrollments',
  paidEnrollments: 'Paid enrollments',
  organicEnrollments: 'Organic enrollments',
  unattributedEnrollments: 'Unclassified enrollments',
  consultsBooked: 'Consults booked',
  roadmapsBooked: 'Roadmaps booked',
  applied: 'Applied',
  enrolled: 'Enrolled',
  count: 'count',
  rate: 'rate',
  coverage: 'coverage',
  conversionFromPrevious: 'conversion from previous stage',
  dropOff: 'drop-off',
  clients: 'new paying clients',
  cashCents: 'new-client cash',
  baselineClientsPerWeek: 'baseline clients/week',
  baselineCashPerWeekCents: 'baseline cash/week',
  ratioClients: 'clients vs baseline',
  ratioCash: 'cash vs baseline',
  enrollmentsPerWeek: 'enrollments/week',
  newPayingClientsPerWeek: 'new paying clients/week',
  initialCashPerWeekCents: 'initial cash/week',
  spendPerWeekCents: 'spend/week',
  enrolledInGhl: 'enrolled in GHL',
  paidInStripe: 'paid in Stripe',
  paidUnmatched: 'first payments unmatched',
  used: 'records used',
  total: 'records total',
};

function labelFor(key: string): string {
  return KEY_LABELS[key] ?? GLOSSARY_LABELS.get(metricKeyOfKpi(key)) ?? GLOSSARY_LABELS.get(key) ?? key;
}

/** The name an array row goes by, read from the row itself. */
function rowName(row: unknown): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const o = row as Record<string, unknown>;
  for (const k of ['name', 'campaign', 'campaignName', 'label', 'kpi', 'metric', 'key', 'source', 'type', 'stage', 'role']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
  if (typeof o.from === 'string' && typeof o.to === 'string') return `${o.from}→${o.to}`;
  return null;
}

/** "kpis · Paid CAC · current" for data.kpis.paidCacCents.current; "campaigns · Summer Shred · Spend" for data.campaigns[2].spendCents. */
export function labelForPath(path: string, data: unknown): string {
  const segs = path.replace(/^data\.?/, '').split(/\.(?![^[]*\])/).filter(Boolean);
  const parts: string[] = [];
  let node: unknown = data;
  for (const seg of segs) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(seg);
    const key = m ? m[1] : seg;
    const idx = m ? [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1])) : [];
    parts.push(labelFor(key));
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    for (const i of idx) {
      node = Array.isArray(node) ? node[i] : undefined;
      parts.push(rowName(node) ?? `#${i + 1}`);
    }
  }
  return parts.join(' · ');
}

/** One line per citeable leaf: "<label> → {<ref>}". Numbers always; strings only for the text-ref keys. */
export function refIndex(ref: string, data: unknown): string[] {
  const entries: LedgerEntry[] = ledgerEntries(ref, data, '', '');
  return entries.map((e) => `${labelForPath(e.ref.slice(ref.length + 1), data)}${e.unit === 'text' ? ' (text)' : ''} → {${e.ref}}`);
}
