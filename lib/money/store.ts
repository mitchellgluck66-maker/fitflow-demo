/**
 * Money settings + fx_rates — the DB side of lib/money (server only).
 *
 * `reporting_currency` is ONE business-wide value (settings table, default
 * CAD): the dashboard, the digests and the AI context all use it — it is not
 * a per-browser preference. `contract_value_currency` is the currency GHL
 * opportunity values are entered in (the location's; assumed CAD until
 * confirmed). Rates: USD→CAD rows only; CAD→USD is derived.
 */

import { asc, sql } from 'drizzle-orm';
import { db, fxRates } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';
import { DEFAULT_REPORTING_CURRENCY, parseCurrency, type Currency, type FxRate, type MoneyContext } from './index';

export async function getReportingCurrency(): Promise<Currency> {
  return parseCurrency(await getSetting(SETTING_KEYS.reportingCurrency)) ?? DEFAULT_REPORTING_CURRENCY;
}

export async function setReportingCurrency(currency: Currency): Promise<void> {
  await setSetting(SETTING_KEYS.reportingCurrency, currency);
}

export async function getContractCurrency(): Promise<Currency> {
  return parseCurrency(await getSetting(SETTING_KEYS.contractValueCurrency)) ?? 'CAD';
}

export async function listFxRates(): Promise<FxRate[]> {
  const rows = await db.select().from(fxRates).orderBy(asc(fxRates.date));
  const out: FxRate[] = [];
  for (const r of rows) {
    const from = parseCurrency(r.fromCcy);
    const to = parseCurrency(r.toCcy);
    if (from && to && r.rate > 0) out.push({ date: r.date, from, to, rate: r.rate, source: r.source });
  }
  return out;
}

/** Everything the engine needs to convert — read once per request. */
export async function loadMoneyContext(): Promise<MoneyContext> {
  const [reporting, contractCurrency, rates] = await Promise.all([getReportingCurrency(), getContractCurrency(), listFxRates()]);
  return { reporting, contractCurrency, rates };
}

/**
 * Setup → Currency: the maintained USD→CAD rate, effective from `date`
 * (today) until the next row. Upserts one manual row; history is untouched,
 * so past periods keep converting at the rate of their own dates.
 */
export async function setUsdCadRate(rate: number, date: string): Promise<void> {
  if (!(rate > 0.5 && rate < 3)) throw new Error('USD→CAD rate must be between 0.5 and 3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  await db
    .insert(fxRates)
    .values({ date, fromCcy: 'USD', toCcy: 'CAD', rate, source: 'manual', updatedAt: new Date() })
    .onConflictDoUpdate({ target: [fxRates.date, fxRates.fromCcy, fxRates.toCcy], set: { rate, source: 'manual', updatedAt: sql`now()` } });
}
