/**
 * Companion stage 3, item 2 — the report model every builder produces and the ONE renderer turns into HTML + text.
 * The renderers FORMAT; every number arrives from the engine / the onboarding numbers function already computed.
 * Order on the page (the approved canvas): headline → totals → Needs attention FIRST → details → the button.
 */

import { shell, sectionTitle, statRow, table, note, bullets, headline, button, textHeader, textTable, escapeHtml } from '../email/templates';
import { REPORT_LABELS, type ReportKind } from './kinds';

export interface ReportCard {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'neutral';
}

export type ReportSection =
  | { type: 'stats'; title: string; hint?: string; cards: ReportCard[] }
  | { type: 'table'; title: string; hint?: string; headers: string[]; rows: string[][]; align?: Array<'left' | 'right'> }
  | { type: 'lines'; title: string; hint?: string; lines: string[]; tone?: 'normal' | 'bad' | 'warn' }
  | { type: 'text'; title?: string; text: string; tone?: 'info' | 'warn' };

export interface ReportModel {
  kind: ReportKind;
  period: { start: string; end: string; label: string };
  /** "<Report> · <period> · <one-line headline>" */
  subject: string;
  /** The sentence the email opens with, written from the numbers. */
  headline: string;
  totals: ReportCard[];
  /** Needs attention — rendered FIRST after the totals. Empty = "Nothing needs attention." */
  attention: string[];
  sections: ReportSection[];
  /** Data-health line (open incidents, stale sources) — rendered under the attention block. */
  health: string | null;
  button: { label: string; path: string };
  footer: string;
  /** Nothing happened in the period: the scheduled send is skipped (a forced / test send still renders). */
  empty: boolean;
}

export function reportSubject(kind: ReportKind, periodLabel: string, headlineText: string): string {
  return `${REPORT_LABELS[kind].replace(' report', '')} · ${periodLabel} · ${headlineText}`;
}

/** The app's public origin for the button (APP_URL, else Vercel's production host, else relative). */
export function appOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.APP_URL?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/+$/, '')}` : '';
}

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function sectionHtml(s: ReportSection): string {
  switch (s.type) {
    case 'stats':
      return sectionTitle(s.title, s.hint) + chunk(s.cards, 4).map((row) => statRow(row)).join('<div style="height:6px"></div>');
    case 'table':
      return sectionTitle(s.title, s.hint) + table(s.headers, s.rows, s.align);
    case 'lines':
      return sectionTitle(s.title, s.hint) + (s.lines.length ? bullets(s.lines, s.tone) : `<div style="font-size:13px;color:#9ca3af;padding:4px 0 8px;">Nothing to show.</div>`);
    case 'text':
      return (s.title ? sectionTitle(s.title) : '') + note(s.text, s.tone ?? 'info');
  }
}

function sectionText(s: ReportSection): string[] {
  const title = (t: string, hint?: string) => [t.toUpperCase() + (hint ? ` · ${hint}` : ''), '-'.repeat(40)];
  switch (s.type) {
    case 'stats':
      return [...title(s.title, s.hint), ...s.cards.map((c) => `${c.label.padEnd(26)} ${c.value.padEnd(14)} ${c.sub ?? ''}`.trimEnd()), ''];
    case 'table':
      return [...title(s.title, s.hint), ...(s.rows.length ? textTable(s.headers, s.rows) : ['Nothing to show.']), ''];
    case 'lines':
      return [...title(s.title, s.hint), ...(s.lines.length ? s.lines.map((l) => `  - ${l}`) : ['Nothing to show.']), ''];
    case 'text':
      return [...(s.title ? title(s.title) : []), s.text, ''];
  }
}

export function renderReport(m: ReportModel, origin: string = appOrigin()): { html: string; text: string } {
  const url = `${origin}${m.button.path}`;
  const attentionHtml =
    sectionTitle('Needs attention', m.attention.length ? `${m.attention.length}` : undefined) +
    (m.attention.length ? bullets(m.attention, 'bad') : `<div style="font-size:13px;color:#128a5c;padding:4px 0 8px;">Nothing needs attention.</div>`);
  const bodyHtml =
    headline(m.headline) +
    statRow(m.totals.slice(0, 4)) +
    (m.totals.length > 4 ? '<div style="height:6px"></div>' + statRow(m.totals.slice(4, 8)) : '') +
    attentionHtml +
    (m.health ? `<div style="font-size:12.5px;color:#55585e;margin:6px 0 0;">${escapeHtml(m.health)}</div>` : '') +
    m.sections.map(sectionHtml).join('') +
    button(m.button.label, url);
  const html = shell({ kicker: REPORT_LABELS[m.kind], title: m.period.label, subtitle: m.subject.split(' · ').slice(2).join(' · ') || null, bodyHtml, footerNote: m.footer });
  const text = [
    ...textHeader(REPORT_LABELS[m.kind], m.period.label),
    m.headline,
    '',
    ...m.totals.map((c) => `${c.label.padEnd(26)} ${c.value.padEnd(14)} ${c.sub ?? ''}`.trimEnd()),
    '',
    'NEEDS ATTENTION',
    '-'.repeat(40),
    ...(m.attention.length ? m.attention.map((a) => `  - ${a}`) : ['Nothing needs attention.']),
    ...(m.health ? ['', m.health] : []),
    '',
    ...m.sections.flatMap(sectionText),
    `${m.button.label}: ${url}`,
    '',
    m.footer,
  ].join('\n');
  return { html, text };
}
