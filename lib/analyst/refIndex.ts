/**
 * The ref index (2026-10-06, item 2; compacted 2026-10-07, item 5): every tool result carries `refs` — the exact
 * paths and keys a token may be built from, so the model never invents a key name ("paidCac" for "paidCacCents").
 *
 * Oct 7: the first index wrote one full token per leaf with a label (21.7K chars against 7.1K of data — 3× the
 * data it indexed, and the bulk of the cold prefix's growth). It is now ONE line per parent object:
 *
 *   token = {r2:data.<parent>.<key>} — paths and keys exactly as listed; (text) marks a text ref
 *   data.kpis.paidCacCents (Paid CAC) → current · previous · abs · pct
 *   data.campaigns[0] "Summer Shred — Broad" → campaign(text) · spendCents · roas
 *
 * The one composition the rule allows is parent + "." + key, both copied from a line. `indexTokens` is the
 * inverse (used by the tests to prove every listed key resolves). Built from the same ledger walk the verifier
 * uses; kept OUTSIDE `data` so the index is never indexed. PURE.
 */

import { ledgerEntries, type LedgerEntry } from './ledger';
import { GLOSSARY } from '../metrics/glossary';
import { metricKeyOfKpi } from '../metrics/maturity';

const GLOSSARY_LABELS = new Map(GLOSSARY.map((e) => [e.key, e.label]));

/** Field names that are not glossary keys, as the owner reads them (only parents are labelled; a key that reads as itself needs none). */
const KEY_LABELS: Record<string, string> = {
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
  ltvCoverage: 'LTV:CAC coverage',
  enrollmentReconciliation: 'enrolled in GHL vs paid in Stripe',
  spendGate: 'spend gate',
};

export function labelFor(key: string): string {
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

const SEP = ' → ';
const KEY_SEP = ' · ';

/** The value at a `data.…` path (object keys and [i] indexes). */
function at(data: unknown, parentPath: string): unknown {
  let node: unknown = data;
  for (const seg of parentPath.replace(/^data\.?/, '').split(/\.(?![^[]*\])/).filter(Boolean)) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(seg);
    const key = m ? m[1] : seg;
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    for (const x of m ? m[2].matchAll(/\[(\d+)\]/g) : []) node = Array.isArray(node) ? node[Number(x[1])] : undefined;
  }
  return node;
}

/** The parent's annotation: `(Paid CAC)` for a labelled key, `"Summer Shred"` for an array row, nothing otherwise. */
function parentNote(parentPath: string, data: unknown): string {
  const last = parentPath.split(/\.(?![^[]*\])/).pop() ?? '';
  if (/\[\d+\]$/.test(last)) {
    const name = rowName(at(data, parentPath));
    return name ? ` "${name.replace(/"/g, "'")}"` : '';
  }
  const label = labelFor(last);
  return label !== last ? ` (${label})` : '';
}

export function indexRule(ref: string): string {
  return `token = {${ref}:data.<parent>.<key>} — paths and keys exactly as listed; (text) marks a text ref`;
}

/** The compact index: the rule, then one line per parent — `<parent path>[ (label) | "row name"] → key · key(text) · …`. */
export function refIndex(ref: string, data: unknown): string[] {
  const entries: LedgerEntry[] = ledgerEntries(ref, data, '', '');
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const path = e.ref.slice(ref.length + 1); // data.…
    const cut = Math.max(path.lastIndexOf('.'), 0);
    const parent = path.slice(0, cut);
    const key = path.slice(cut + 1);
    const list = groups.get(parent) ?? [];
    list.push(e.unit === 'text' ? `${key}(text)` : key);
    groups.set(parent, list);
  }
  return [indexRule(ref), ...[...groups.entries()].map(([parent, keys]) => `${parent}${parentNote(parent, data)}${SEP}${keys.join(KEY_SEP)}`)];
}

/** The inverse of `refIndex`: every token the lines license (pure). */
export function indexTokens(ref: string, lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const i = line.indexOf(SEP);
    if (i < 0) continue;
    const parent = line.slice(0, i).split(' ')[0];
    for (const k of line.slice(i + SEP.length).split(KEY_SEP)) out.push(`{${ref}:${parent}.${k.replace(/\(text\)$/, '')}}`);
  }
  return out;
}
