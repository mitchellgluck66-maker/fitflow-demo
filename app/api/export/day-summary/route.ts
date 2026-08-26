import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, contacts, stages } from '@/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDayBounds, todayInTimezone, formatDayLabel } from '@/lib/day';
import {
  getTimezone,
  getSetting,
  rememberRecipient,
  getRecipientHistory,
  SETTING_KEYS,
} from '@/lib/settings';
import {
  buildHtmlSummary,
  buildTextSummary,
  buildCsvSummary,
  computeStats,
  sendSummaryEmail,
  type DaySummaryData,
} from '@/lib/summary';

export const dynamic = 'force-dynamic';

async function loadDay(date: string, timezone: string): Promise<DaySummaryData> {
  const { startMs, endMs } = getDayBounds(date, timezone);

  const rows = await db
    .select({
      startTime: appointments.startTime,
      type: appointments.type,
      outcome: appointments.outcome,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      stage: stages.name,
      owner: contacts.ownerName,
      estimatedValue: contacts.monetaryValueCents,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .where(and(gte(appointments.startTime, new Date(startMs)), lte(appointments.startTime, new Date(endMs))))
    .orderBy(asc(appointments.startTime));

  return {
    date,
    timezone,
    appointments: rows.map((r) => ({
      ...r,
      startTime: r.startTime.toISOString(),
      firstName: r.firstName ?? 'Unknown',
      lastName: r.lastName ?? '',
      email: r.email ?? '',
    })),
  };
}

/**
 * GET /api/export/day-summary?date=&format=html|text|csv
 * Preview or download without sending. Also returns the remembered recipient so
 * the dialog can pre-fill it.
 */
export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const date = request.nextUrl.searchParams.get('date') ?? todayInTimezone(timezone);
    const format = request.nextUrl.searchParams.get('format') ?? 'json';

    const data = await loadDay(date, timezone);

    if (format === 'csv') {
      return new NextResponse(buildCsvSummary(data), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="fitflow-day-summary-${date}.csv"`,
        },
      });
    }

    if (format === 'html') {
      return new NextResponse(buildHtmlSummary(data), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    if (format === 'text') {
      return new NextResponse(buildTextSummary(data), {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json({
      date,
      timezone,
      stats: computeStats(data),
      // Pre-fill: the address used last time, plus recent ones as suggestions.
      rememberedEmail: await getSetting(SETTING_KEYS.summaryRecipientEmail),
      recentEmails: await getRecipientHistory(),
      emailConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
      preview: buildTextSummary(data),
    });
  } catch (error) {
    console.error('Failed to build day summary:', error);
    return NextResponse.json(
      { error: 'Failed to build day summary', detail: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/export/day-summary
 * Body: { email, date? }
 *
 * Sends the summary and remembers the address for next time.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = String(body.email ?? '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: 'A valid email address is required' },
        { status: 400 },
      );
    }

    const timezone = await getTimezone();
    const date = body.date ?? todayInTimezone(timezone);
    const data = await loadDay(date, timezone);
    const stats = computeStats(data);

    const html = buildHtmlSummary(data);
    const text = buildTextSummary(data);
    const subject = `FitFlow Day Summary — ${formatDayLabel(date, timezone)} (${stats.showed} showed, ${stats.noShow} no-show)`;

    const sendResult = await sendSummaryEmail({ to: email, subject, html, text });

    // Remember the address whether or not delivery succeeded - the user's intent
    // to send there is the same either way, and re-typing it after a transient
    // Resend error would be annoying.
    await rememberRecipient(email);

    return NextResponse.json({
      ok: sendResult.sent,
      sent: sendResult.sent,
      provider: sendResult.provider,
      message: sendResult.message,
      emailId: sendResult.id,
      recipient: email,
      remembered: true,
      date,
      stats,
      // Returned so the UI can offer a download when sending wasn't possible.
      html: sendResult.sent ? undefined : html,
    });
  } catch (error) {
    console.error('Failed to send day summary:', error);
    return NextResponse.json(
      { error: 'Failed to send day summary', detail: String(error) },
      { status: 500 },
    );
  }
}
