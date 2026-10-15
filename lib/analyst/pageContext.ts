/**
 * Page context (Wave 2 item 5, 2026-10-15) — PURE, client-safe. The panel tells the Analyst what the owner is looking
 * at: the page, the range on screen (through the SAME `rangeFromParams` the pages use, so the context range equals the
 * range the page requested), the comparison, the funnel mode, and what was clicked (a metric's explain button, a
 * campaign row, a client, a funnel stage). Composed into the user turn once (`composeUserTurn`'s "Viewing" line) and
 * stored on the turn. An unknown route sends `page: "unknown"` and no range, and the Analyst asks which range.
 */

import { rangeFromParams, type DateRange } from '../dates';
import type { PageContext } from './prompts';

export type PageKey = 'command_center' | 'scorecard' | 'funnel' | 'ads' | 'revenue' | 'clients' | 'client' | 'reports' | 'setup' | 'metrics' | 'unknown';

export const PAGE_LABELS: Record<PageKey, string> = {
  command_center: 'Command Center',
  scorecard: 'Scorecard',
  funnel: 'Funnel',
  ads: 'Ads',
  revenue: 'Revenue',
  clients: 'Clients',
  client: 'Client',
  reports: 'Reports',
  setup: 'Setup',
  metrics: 'Metrics',
  unknown: 'FitFlow',
};

/** Pages that carry the global date picker — only these send a range (the default when the URL names none). */
const RANGED: Partial<Record<PageKey, string>> = { command_center: 'last_30_days', scorecard: 'last_week', funnel: 'last_30_days', ads: 'last_30_days', revenue: 'last_30_days', metrics: 'last_30_days' };

export function pageKeyFor(pathname: string): { page: PageKey; clientId: string | null } {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { page: 'command_center', clientId: null };
  const m = /^\/clients\/([^/]+)$/.exec(p);
  if (m) return { page: 'client', clientId: decodeURIComponent(m[1]) };
  const first = p.split('/')[1];
  const known: Record<string, PageKey> = { scorecard: 'scorecard', funnel: 'funnel', ads: 'ads', revenue: 'revenue', clients: 'clients', reports: 'reports', setup: 'setup', metrics: 'metrics' };
  return { page: known[first] ?? 'unknown', clientId: null };
}

export interface SearchParamsLike {
  get(name: string): string | null;
}

export type Selected = NonNullable<PageContext['selected']>;

/** The context for a page as the URL shows it; `selected` is what the owner clicked (added by the trigger). */
export interface PageContextView extends PageContext {
  page: PageKey;
  selected: Selected | null;
  dateRange: DateRange | null;
}

export function pageContextFor(pathname: string, params: SearchParamsLike | null, today: string, selected: Selected | null = null): PageContextView {
  const { page, clientId } = pageKeyFor(pathname);
  const defaultPreset = RANGED[page];
  let dateRange: DateRange | null = null;
  if (defaultPreset) {
    const range = params?.get('range') ?? null;
    const start = params?.get('start') ?? null;
    const end = params?.get('end') ?? null;
    // The page's own default only when the URL names nothing: start + end alone is a custom range (as the pages read it).
    dateRange = rangeFromParams({ range: range ?? (start && end ? null : defaultPreset), start, end }, today);
  }
  const compareParam = params?.get('compare');
  const compare = dateRange ? (compareParam === 'last_year' || compareParam === 'off' ? compareParam : 'previous_period') : null;
  const mode = page === 'funnel' ? (params?.get('mode') === 'period' ? 'period' : 'cohort') : null;
  const sel: Selected | null = selected ?? (page === 'client' && clientId ? { kind: 'client', id: clientId } : null);
  return {
    page,
    range: dateRange ? { start: dateRange.start, end: dateRange.end, label: `${dateRange.presetLabel} · ${dateRange.resolvedLabel}` } : null,
    compare,
    mode,
    selected: sel,
    dateRange,
  };
}

/** "Viewing Command Center · Oct 4–10" / "Viewing Paid CAC · Oct 4–10" — the context pill's text before the freshness part. */
export function contextPillText(ctx: { page: PageKey; dateRange: DateRange | null; selected: Selected | null }): string {
  const what = ctx.selected?.label ?? PAGE_LABELS[ctx.page];
  return ctx.dateRange ? `Viewing ${what} · ${ctx.dateRange.resolvedLabel}` : `Viewing ${what}`;
}
