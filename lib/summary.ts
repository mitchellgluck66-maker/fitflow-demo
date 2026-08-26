/**
 * Day summary generation + delivery.
 *
 * Produces the end-of-day attendance recap as HTML (for email), plain text, and
 * CSV. Delivery goes through Resend when RESEND_API_KEY is set; without a key
 * the summary is still generated and returned so it can be downloaded, rather
 * than the feature failing outright.
 */

import { formatDayLabel, formatTime } from './day';

export interface SummaryAppointment {
  startTime: string;
  type: string;
  firstName: string;
  lastName: string;
  email: string;
  stage: string | null;
  owner: string | null;
  /** showed | no_show | cancelled | null — mirrors GHL's appointmentStatus. */
  outcome: string | null;
  estimatedValue: number | null;
}

export interface DaySummaryData {
  date: string;
  timezone: string;
  appointments: SummaryAppointment[];
}

const OUTCOME_COLORS: Record<string, string> = {
  showed: '#059669',
  no_show: '#d97706',
  cancelled: '#dc2626',
};

const OUTCOME_LABELS: Record<string, string> = {
  showed: 'Showed',
  no_show: 'No Show',
  cancelled: 'Cancelled',
};

function outcomeLabel(outcome: string | null): string {
  if (!outcome) return 'Not recorded';
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function computeStats(data: DaySummaryData) {
  const { appointments } = data;
  const marked = appointments.filter((a) => a.outcome);

  const showed = appointments.filter((a) => a.outcome === 'showed').length;
  const noShow = appointments.filter((a) => a.outcome === 'no_show').length;
  const cancelled = appointments.filter((a) => a.outcome === 'cancelled').length;
  const unmarked = appointments.length - marked.length;

  const decided = showed + noShow;
  const showRate = decided > 0 ? Math.round((showed / decided) * 100) : 0;

  const pipelineValue = appointments
    .filter((a) => a.outcome === 'showed')
    .reduce((sum, a) => sum + (a.estimatedValue ?? 0), 0);

  return {
    total: appointments.length,
    marked: marked.length,
    unmarked,
    showed,
    noShow,
    cancelled,
    showRate,
    pipelineValue,
  };
}

export function buildHtmlSummary(data: DaySummaryData): string {
  const stats = computeStats(data);
  const dayLabel = formatDayLabel(data.date, data.timezone);

  const rows = data.appointments
    .map((a) => {
      const color = a.outcome ? OUTCOME_COLORS[a.outcome] ?? '#6b7280' : '#9ca3af';
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-variant-numeric:tabular-nums;color:#374151;">${formatTime(a.startTime, data.timezone)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:600;color:#111827;">${escapeHtml(a.firstName)} ${escapeHtml(a.lastName)}</div>
          <div style="font-size:12px;color:#6b7280;">${escapeHtml(a.email)}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">${escapeHtml(a.type)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
          <span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${color}1a;color:${color};font-size:12px;font-weight:600;">${outcomeLabel(a.outcome)}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">${escapeHtml(a.owner ?? '—')}</td>
      </tr>`;
    })
    .join('');

  const statCard = (label: string, value: string | number, color: string) => `
    <td style="padding:14px 16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">${label}</div>
      <div style="font-size:26px;font-weight:700;color:${color};margin-top:4px;">${value}</div>
    </td>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">

    <div style="padding:28px 32px;background:linear-gradient(135deg,#2563eb,#7c3aed);">
      <div style="color:rgba(255,255,255,.85);font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;">FitFlow Day Summary</div>
      <div style="color:#ffffff;font-size:24px;font-weight:700;margin-top:6px;">${dayLabel}</div>
    </div>

    <div style="padding:24px 32px;">
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:8px;">
        <tr>
          ${statCard('Appointments', stats.total, '#111827')}
          ${statCard('Showed', stats.showed, '#059669')}
          ${statCard('No Show', stats.noShow, '#d97706')}
          ${statCard('Cancelled', stats.cancelled, '#dc2626')}
        </tr>
      </table>

      <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-top:8px;">
        <tr>
          ${statCard('Show Rate', `${stats.showRate}%`, '#2563eb')}
          ${statCard('Not recorded', stats.unmarked, stats.unmarked > 0 ? '#d97706' : '#059669')}
          ${statCard('New Pipeline', `$${(stats.pipelineValue / 100).toLocaleString()}`, '#059669')}
        </tr>
      </table>

      ${
        stats.unmarked > 0
          ? `<div style="margin-top:18px;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:13px;">
               <strong>${stats.unmarked} appointment${stats.unmarked === 1 ? '' : 's'}</strong> ${stats.unmarked === 1 ? 'was' : 'were'} not yet recorded in GoHighLevel when this summary was generated.
             </div>`
          : ''
      }

      <h3 style="margin:26px 0 10px;font-size:15px;color:#111827;">Appointments</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Time</th>
            <th style="text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Name</th>
            <th style="text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Type</th>
            <th style="text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Outcome</th>
            <th style="text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Owner</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#9ca3af;">No appointments scheduled.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">
      Generated by FitFlow · ${new Date().toISOString()}
    </div>
  </div>
</body>
</html>`;
}

export function buildTextSummary(data: DaySummaryData): string {
  const stats = computeStats(data);
  const lines = [
    `FitFlow Day Summary - ${formatDayLabel(data.date, data.timezone)}`,
    '='.repeat(56),
    '',
    `Appointments:    ${stats.total}`,
    `Showed:          ${stats.showed}`,
    `No Show:         ${stats.noShow}`,
    `Cancelled:       ${stats.cancelled}`,
    `Not recorded:    ${stats.unmarked}`,
    `Show Rate:       ${stats.showRate}%`,
    '',
    'APPOINTMENTS',
    '-'.repeat(56),
  ];

  for (const a of data.appointments) {
    lines.push(
      `${formatTime(a.startTime, data.timezone).padEnd(9)} ${`${a.firstName} ${a.lastName}`.padEnd(24)} ${a.type.padEnd(12)} ${outcomeLabel(a.outcome)}`,
    );
  }

  if (data.appointments.length === 0) lines.push('No appointments scheduled.');

  return lines.join('\n');
}

export function buildCsvSummary(data: DaySummaryData): string {
  const header = ['Time', 'First Name', 'Last Name', 'Email', 'Type', 'Outcome', 'Stage', 'Owner'];
  const rows = data.appointments.map((a) => [
    formatTime(a.startTime, data.timezone),
    a.firstName,
    a.lastName,
    a.email,
    a.type,
    outcomeLabel(a.outcome),
    a.stage ?? '',
    a.owner ?? '',
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SendResult {
  sent: boolean;
  provider: 'resend' | 'none';
  message: string;
  id?: string;
}

/**
 * Send the summary via Resend.
 *
 * Requires RESEND_API_KEY and RESEND_FROM_EMAIL. When either is missing we
 * return sent:false with a clear reason rather than throwing - the UI falls back
 * to offering the summary as a download.
 */
export async function sendSummaryEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();

  if (!apiKey) {
    return {
      sent: false,
      provider: 'none',
      message:
        'No RESEND_API_KEY configured. The summary was generated but not emailed - download it instead, or add a key to .env.local.',
    };
  }

  if (!from) {
    return {
      sent: false,
      provider: 'none',
      message:
        'RESEND_FROM_EMAIL is not set. Add a verified sender address to .env.local.',
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });

    const payload = (await response.json()) as { id?: string; message?: string };

    if (!response.ok) {
      return {
        sent: false,
        provider: 'resend',
        message: `Resend returned ${response.status}: ${payload.message ?? 'unknown error'}`,
      };
    }

    return {
      sent: true,
      provider: 'resend',
      message: `Day summary sent to ${params.to}.`,
      id: payload.id,
    };
  } catch (error) {
    return {
      sent: false,
      provider: 'resend',
      message: `Failed to reach Resend: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
