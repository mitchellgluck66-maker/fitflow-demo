import { NextRequest, NextResponse } from 'next/server';
import { dbTimeout, apiErrorResponse } from '@/lib/dbTimeout';
import { z } from 'zod';
import { getTimezone, setSetting, SETTING_KEYS } from '@/lib/settings';
import { todayInTimezone } from '@/lib/dates';
import { CURRENCIES, fxNote, rateFor } from '@/lib/money';
import { loadMoneyContext, setReportingCurrency, setUsdCadRate } from '@/lib/money/store';

export const dynamic = 'force-dynamic';

/** GET /api/currency — reporting currency, contract currency, stored USD→CAD rates and today's active rate. */
export async function GET() {
  try {
    const [ctx, tz] = await dbTimeout(Promise.all([loadMoneyContext(), getTimezone()]), 'currency settings');
    const today = todayInTimezone(tz);
    let usdCad: number | null = null;
    try {
      usdCad = rateFor(ctx.rates, 'USD', 'CAD', today);
    } catch {
      usdCad = null;
    }
    return NextResponse.json({
      today,
      reporting: ctx.reporting,
      contractCurrency: ctx.contractCurrency,
      usdCad,
      note: fxNote(ctx, today).text,
      rates: ctx.rates.slice(-18).reverse(),
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load currency settings');
  }
}

const Body = z.object({
  /** The maintained USD→CAD rate, effective from today (business tz). */
  usdCadRate: z.number().gt(0.5).lt(3).optional(),
  contractCurrency: z.enum(CURRENCIES).optional(),
  /** The ONE business-wide reporting currency (nav toggle / Setup) — dashboard, digests and AI context. */
  reportingCurrency: z.enum(CURRENCIES).optional(),
});

/** POST /api/currency — the nav toggle and Setup → Currency. */
export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, { status: 400 });
  try {
    const today = todayInTimezone(await getTimezone());
    if (parsed.data.usdCadRate !== undefined) await setUsdCadRate(parsed.data.usdCadRate, today);
    if (parsed.data.reportingCurrency) await setReportingCurrency(parsed.data.reportingCurrency);
    if (parsed.data.contractCurrency) await setSetting(SETTING_KEYS.contractValueCurrency, parsed.data.contractCurrency);
    return GET();
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save currency settings', detail: String(error) }, { status: 500 });
  }
}
