/**
 * Pure grouping for the Setup incident log: consecutive incidents (sorted
 * newest-first) with the same kind + severity + message collapse into one row
 * with a ×N count and first/last timestamps. Consecutive-only on purpose — an
 * error that stopped, gave way to something else, then came back is two
 * episodes, not one.
 */

export interface IncidentRow {
  id: string;
  kind: string;
  severity: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface IncidentGroup {
  /** id of the newest incident in the group (stable React key). */
  id: string;
  kind: string;
  severity: string;
  message: string;
  count: number;
  /** ISO timestamps: earliest and latest occurrence in the group. */
  firstAt: string;
  lastAt: string;
  /** Every incident id in the group — what "Resolve all" resolves. */
  ids: string[];
  resolved: boolean;
}

export function groupIncidents(rows: IncidentRow[]): IncidentGroup[] {
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const groups: IncidentGroup[] = [];
  for (const r of sorted) {
    const last = groups[groups.length - 1];
    const resolved = r.resolvedAt !== null;
    if (last && last.kind === r.kind && last.severity === r.severity && last.message === r.message && last.resolved === resolved) {
      last.count += 1;
      last.firstAt = r.createdAt; // rows arrive newest-first, so each next one is earlier
      last.ids.push(r.id);
    } else {
      groups.push({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        message: r.message,
        count: 1,
        firstAt: r.createdAt,
        lastAt: r.createdAt,
        ids: [r.id],
        resolved,
      });
    }
  }
  return groups;
}
