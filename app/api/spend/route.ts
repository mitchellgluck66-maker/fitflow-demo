import { NextRequest, NextResponse } from 'next/server';
import { readMetaAccount } from '@/lib/meta/ingest';
import { and, eq, gte, lte, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db, adSpend } from '@/db';
import { weekStart, weekEnd, formatRangeLabel, todayInTimezone, isValidDate } from '@/lib/dates';
import { getTimezone } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const PLATFORMS = ['meta', 'google', 'other'] as const;

export interface SpendRowView {
  platform: string;
  spendCents: number;
  /** The currency the row's amount is stored in (P1 #8: Meta bills CAD; never assumed). */
  currency: string;
  origin: string;
  enteredBy: string | null;
  updatedAt: string;
  externalId: string;
  notes: string | null;
}

export interface SpendWeekView {
  start: string;
  end: string;
  label: string;
  rows: SpendRowView[];
  totals: Record<string, number>;
}

function manualId(platform: string, start: string): string {
  return `manual:${platform}:${start}`;
}

async function loadWeek(start: string): Promise<SpendWeekView> {
  const end = weekEnd(start);
  const rows = await db
    .select()
    .from(adSpend)
    .where(and(gte(adSpend.date, start), lte(adSpend.date, end)))
    .orderBy(desc(adSpend.updatedAt));
  // One line per platform + CURRENCY per week: API/demo daily rows are summed within their currency (cents in
  // different currencies are never added together — P1 #8); a manual row (at most one per platform+week) is shown
  // as itself.
  const byPlatform = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const key = `${r.platform}:${r.currency}`;
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key)!.push(r);
  }
  const view = Array.from(byPlatform.values()).map((list) => {
    const manual = list.find((r) => r.origin === 'manual');
    const lead = manual ?? list[0];
    return {
      platform: lead.platform,
      currency: lead.currency,
      spendCents: manual ? manual.spendCents : list.reduce((s, r) => s + r.spendCents, 0),
      origin: lead.origin,
      enteredBy: lead.enteredBy,
      updatedAt: lead.updatedAt.toISOString(),
      externalId: lead.externalId,
      notes: lead.notes,
      /** How many daily rows were summed (0 for a manual entry). */
      dailyRows: manual ? 0 : list.length,
    };
  });
  return {
    start,
    end,
    label: formatRangeLabel(start, end),
    rows: view,
    /** Per currency — a week can hold CAD (Meta) and USD (Google) rows and they are never summed together. */
    totals: view.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.currency]: (acc[r.currency] ?? 0) + r.spendCents }), {}),
  };
}

/** GET /api/spend?weeks=12 — the last N Sun–Sat weeks (newest first) with their spend rows. */
export async function GET(request: NextRequest) {
  try {
    const n = Math.min(52, Math.max(1, Number(request.nextUrl.searchParams.get('weeks') ?? 12) || 12));
    const today = todayInTimezone(await getTimezone());
    const current = weekStart(today);
    const weeks: SpendWeekView[] = [];
    for (let i = 0; i < n; i += 1) {
      const d = new Date(`${current}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push(await loadWeek(d.toISOString().slice(0, 10)));
    }
    // The currency each platform's account bills in, when a source has told us (Meta: the account read each sync;
    // Google: its latest API row) — the form preselects it; the user can still change it. Never assumed.
    const metaAccount = await readMetaAccount();
    const [g] = await db.select({ currency: adSpend.currency }).from(adSpend).where(and(eq(adSpend.platform, 'google'), eq(adSpend.origin, 'google'))).orderBy(desc(adSpend.syncedAt)).limit(1);
    const accountCurrency: Record<string, string | null> = { meta: metaAccount?.currency ?? null, google: g?.currency ?? null };
    return NextResponse.json({ platforms: PLATFORMS, currentWeekStart: current, weeks, accountCurrency });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load spend', detail: String(error) }, { status: 500 });
  }
}

const PostSchema = z.object({
  weekOf: z.string().refine(isValidDate, 'weekOf must be YYYY-MM-DD'),
  platform: z.enum(PLATFORMS),
  amountDollars: z.number().min(0).max(10_000_000),
  /** The currency the amount was entered in — required, never defaulted (2026-09-30; was hard-coded USD). */
  currency: z.enum(['CAD', 'USD'], { message: 'currency is required: CAD or USD (the currency the ad account bills in)' }),
  notes: z.string().max(500).optional(),
});

/**
 * POST /api/spend — upsert a manual weekly spend row (amount 0 deletes it).
 * Only rows with origin='manual' are ever written; a 'demo' row for the same
 * platform+week is removed so the real entry replaces the sample.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = PostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
    }
    const { weekOf, platform, amountDollars, currency, notes } = parsed.data;
    const start = weekStart(weekOf);
    const end = weekEnd(start);
    const externalId = manualId(platform, start);
    const now = new Date();

    // Sample rows for this platform+week give way to the real entry.
    await db
      .delete(adSpend)
      .where(and(eq(adSpend.origin, 'demo'), eq(adSpend.platform, platform), gte(adSpend.date, start), lte(adSpend.date, end)));

    if (amountDollars === 0) {
      await db.delete(adSpend).where(and(eq(adSpend.externalId, externalId), eq(adSpend.origin, 'manual')));
    } else {
      const spendCents = Math.round(amountDollars * 100);
      await db
        .insert(adSpend)
        .values({
          platform,
          externalId,
          date: start,
          spendCents,
          currency,
          enteredBy: 'setup',
          notes: notes ?? null,
          source: 'manual',
          origin: 'manual',
          syncedAt: now,
          backfilled: false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: adSpend.externalId,
          set: { spendCents, currency, notes: notes ?? null, enteredBy: 'setup', syncedAt: now, updatedAt: now },
          setWhere: eq(adSpend.origin, 'manual'),
        });
    }

    return NextResponse.json({ ok: true, week: await loadWeek(start) });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save spend', detail: String(error) }, { status: 500 });
  }
}

/** DELETE /api/spend?externalId=manual:meta:2026-08-16 — remove one manual row. */
export async function DELETE(request: NextRequest) {
  try {
    const externalId = request.nextUrl.searchParams.get('externalId') ?? '';
    if (!externalId.startsWith('manual:')) {
      return NextResponse.json({ error: 'Only manual rows can be deleted' }, { status: 400 });
    }
    await db.delete(adSpend).where(and(eq(adSpend.externalId, externalId), eq(adSpend.origin, 'manual')));
    const start = externalId.split(':')[2];
    return NextResponse.json({ ok: true, week: isValidDate(start) ? await loadWeek(weekStart(start)) : null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete spend', detail: String(error) }, { status: 500 });
  }
}
