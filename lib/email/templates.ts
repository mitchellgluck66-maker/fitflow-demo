/**
 * Email scaffold shared by every digest. Inline CSS, table layout, one accent.
 * Scorecard rule: exactly one timeframe per digest, stated in the header.
 */

const ACCENT = '#6d33f2';
const TEXT = '#0c0d0e';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface Shell {
  /** "Daily to-do" */
  kicker: string;
  /** "Wednesday, Aug 26, 2026" or "Week of Aug 16–22" */
  title: string;
  /** "vs Aug 9–15" — the single comparison, or null */
  subtitle?: string | null;
  /** Rendered body sections. */
  bodyHtml: string;
  footerNote?: string;
}

export function shell(s: Shell): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.title)}</title></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:${FONT};color:${TEXT};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="680" style="max-width:680px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};" cellspacing="0" cellpadding="0">
    <tr><td style="padding:26px 32px;background:${ACCENT};">
      <div style="color:rgba(255,255,255,.8);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">FitFlow · ${escapeHtml(s.kicker)}</div>
      <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">${escapeHtml(s.title)}</div>
      ${s.subtitle ? `<div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px;">${escapeHtml(s.subtitle)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:24px 32px;">${s.bodyHtml}</td></tr>
    <tr><td style="padding:14px 32px;background:#f9fafb;border-top:1px solid ${BORDER};color:#9ca3af;font-size:12px;">
      ${escapeHtml(s.footerNote ?? 'Read-only view of GoHighLevel. Nothing in this email changes the pipeline.')}
    </td></tr>
  </table>
  </td></tr></table>
</body></html>`;
}

export function sectionTitle(title: string, hint?: string): string {
  return `<h3 style="margin:22px 0 8px;font-size:14px;font-weight:700;color:${TEXT};">${escapeHtml(title)}${
    hint ? ` <span style="font-weight:400;color:${MUTED};font-size:12px;">· ${escapeHtml(hint)}</span>` : ''
  }</h3>`;
}

export function note(text: string, tone: 'info' | 'warn' = 'info'): string {
  const bg = tone === 'warn' ? '#fffbeb' : '#f5f3ff';
  const bd = tone === 'warn' ? '#fde68a' : '#ddd6fe';
  const fg = tone === 'warn' ? '#92400e' : '#4c1dad';
  return `<div style="margin:10px 0;padding:10px 14px;background:${bg};border:1px solid ${bd};border-radius:8px;color:${fg};font-size:13px;">${escapeHtml(text)}</div>`;
}

/** Row of stat cards (label / value / sub). */
export function statRow(cards: Array<{ label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'neutral' }>): string {
  const color = (t?: string) => (t === 'good' ? '#128a5c' : t === 'bad' ? '#c72d3e' : MUTED);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:6px 0;margin:0 -6px;"><tr>${cards
    .map(
      (c) => `<td valign="top" style="padding:12px 14px;background:#f9fafb;border:1px solid ${BORDER};border-radius:10px;width:${Math.floor(100 / cards.length)}%;">
        <div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.05em;font-weight:600;">${escapeHtml(c.label)}</div>
        <div style="font-size:22px;font-weight:700;color:${TEXT};margin-top:4px;">${escapeHtml(c.value)}</div>
        ${c.sub ? `<div style="font-size:12px;color:${color(c.tone)};margin-top:3px;">${escapeHtml(c.sub)}</div>` : ''}
      </td>`,
    )
    .join('')}</tr></table>`;
}

export function table(headers: string[], rows: string[][], align: Array<'left' | 'right'> = []): string {
  const th = headers
    .map(
      (h, i) =>
        `<th style="text-align:${align[i] ?? 'left'};padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};border-bottom:1px solid ${BORDER};background:#f9fafb;">${escapeHtml(h)}</th>`,
    )
    .join('');
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${r
              .map(
                (c, i) =>
                  `<td style="text-align:${align[i] ?? 'left'};padding:8px 10px;font-size:13px;border-bottom:1px solid ${BORDER};color:${TEXT};">${escapeHtml(c)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:16px;text-align:center;color:#9ca3af;font-size:13px;">Nothing to show.</td></tr>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function peopleList(people: Array<{ name: string; email: string | null; source: string | null; on: string }>): string {
  if (people.length === 0) return `<div style="font-size:13px;color:#9ca3af;padding:4px 0 8px;">Nobody.</div>`;
  return `<ul style="margin:4px 0 10px;padding-left:18px;font-size:13.5px;line-height:1.6;">${people
    .map(
      (p) =>
        `<li><strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(p.email ?? 'no email')} — ${escapeHtml(p.source ?? 'source unknown')} — ${escapeHtml(p.on)}</li>`,
    )
    .join('')}</ul>`;
}

/** Plain-text helpers. */
export function textHeader(kicker: string, title: string, subtitle?: string | null): string[] {
  return [`FitFlow ${kicker} — ${title}`, ...(subtitle ? [subtitle] : []), '='.repeat(60), ''];
}

export function textTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  return [line(headers), '-'.repeat(widths.reduce((a, b) => a + b + 2, 0)), ...rows.map(line)];
}
