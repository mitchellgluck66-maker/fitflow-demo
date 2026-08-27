/**
 * Google Ads CSV export parser — PURE.
 *
 * The UI export has one or two preamble lines ("Campaign report", a date
 * range), a BOM, then a header row containing at least Day/Date, Campaign
 * and Cost. Costs arrive as "$1,234.56"; counts as "1,234"; the last rows
 * are "Total: …" summaries that must be skipped. Quoted fields may contain
 * commas.
 */

export interface GoogleCsvRow {
  /** YYYY-MM-DD */
  date: string;
  campaignId: string | null;
  campaignName: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface GoogleCsvParse {
  rows: GoogleCsvRow[];
  skipped: number;
  warnings: string[];
}

/** RFC-4180-ish line splitter handling quotes and embedded commas/newlines. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES: Record<string, string[]> = {
  date: ['day', 'date'],
  campaign: ['campaign', 'campaignname'],
  campaignId: ['campaignid'],
  cost: ['cost', 'spend', 'amount'],
  impressions: ['impr', 'impressions'],
  clicks: ['clicks'],
  conversions: ['conversions', 'conv', 'allconv'],
};

function findColumns(header: string[]): Record<string, number> | null {
  const cols: Record<string, number> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (cols[key] === undefined && aliases.includes(n)) cols[key] = i;
    }
  });
  if (cols.date === undefined || cols.campaign === undefined || cols.cost === undefined) return null;
  return cols;
}

function toNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const long = Date.parse(v);
  if (!Number.isNaN(long)) return new Date(long).toISOString().slice(0, 10);
  return null;
}

export function parseGoogleAdsCsv(text: string): GoogleCsvParse {
  const clean = text.replace(/^﻿/, '');
  const records = parseCsvRecords(clean).filter((r) => r.some((c) => c.trim() !== ''));
  const warnings: string[] = [];
  let skipped = 0;

  let headerIdx = -1;
  let cols: Record<string, number> | null = null;
  for (let i = 0; i < Math.min(records.length, 10); i += 1) {
    const c = findColumns(records[i]);
    if (c) {
      headerIdx = i;
      cols = c;
      break;
    }
  }
  if (!cols) {
    return { rows: [], skipped: records.length, warnings: ['Could not find a header row with Day/Date, Campaign and Cost columns.'] };
  }
  if (headerIdx > 0) warnings.push(`Skipped ${headerIdx} preamble line${headerIdx === 1 ? '' : 's'} before the header.`);

  const rows: GoogleCsvRow[] = [];
  for (const rec of records.slice(headerIdx + 1)) {
    const first = (rec[0] ?? '').trim().toLowerCase();
    const dateRaw = rec[cols.date];
    if (first.startsWith('total') || (dateRaw ?? '').trim().toLowerCase().startsWith('total')) {
      skipped += 1;
      continue;
    }
    const date = toDate(dateRaw);
    const campaignName = (rec[cols.campaign] ?? '').trim();
    if (!date || !campaignName) {
      skipped += 1;
      if (warnings.length < 5) warnings.push(`Skipped a row without a valid date/campaign: "${rec.slice(0, 3).join(', ')}"`);
      continue;
    }
    rows.push({
      date,
      campaignId: cols.campaignId !== undefined ? (rec[cols.campaignId] ?? '').trim() || null : null,
      campaignName,
      spendCents: Math.round(toNumber(rec[cols.cost]) * 100),
      impressions: Math.round(toNumber(cols.impressions !== undefined ? rec[cols.impressions] : undefined)),
      clicks: Math.round(toNumber(cols.clicks !== undefined ? rec[cols.clicks] : undefined)),
      conversions: toNumber(cols.conversions !== undefined ? rec[cols.conversions] : undefined),
    });
  }
  return { rows, skipped, warnings };
}

export function csvExternalId(row: GoogleCsvRow): string {
  const key = (row.campaignId || row.campaignName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `google_csv:${key}:${row.date}`;
}
