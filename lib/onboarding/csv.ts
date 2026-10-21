/** Companion stage 3 — Export CSV: one row per call, the same fields the table shows. Pure. */

import { ghlResultOf, outcomeLabelOf, stageMoveOf, type OnboardingCall } from './numbers';

export const CSV_HEADERS = ['Date', 'Time', 'Type', 'Calendar', 'Client', 'Technician', 'Outcome', 'Stage before', 'Stage after', 'Deal', 'Note', 'Logged at', 'Logged by', 'GoHighLevel', 'GoHighLevel detail'] as const;

function cell(v: string | null | undefined): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function onboardingCsv(calls: ReadonlyArray<OnboardingCall>): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const c of calls) {
    const r = ghlResultOf(c);
    lines.push(
      [
        c.date,
        c.timeLabel,
        c.callType,
        c.calendarName,
        c.name,
        c.userName,
        outcomeLabelOf(c).label,
        c.log?.before.stageName ?? '',
        c.log?.after.stageName ?? '',
        c.log?.after.status ?? '',
        c.log?.note ?? '',
        c.log?.createdAt ?? '',
        c.log?.userName ?? '',
        r.label,
        r.sub ?? (c.log ? stageMoveOf(c) : ''),
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
