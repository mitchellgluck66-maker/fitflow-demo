/**
 * Money — PURE (CLAUDE.md rule 8, "Currency").
 *
 * Payments arrive in CAD and USD; Meta bills in USD. The business reports in
 * ONE currency (a setting, default CAD). Every stored amount keeps its
 * original currency; conversion happens at READ time, in the metrics engine,
 * at the transaction date's rate from `fx_rates`. Nothing is converted in
 * place in the database.
 *
 * Guarantees:
 *   - `convertCents` is identity when from === to, so converting an
 *     already-converted amount (which is labelled with the reporting
 *     currency) can never double-convert.
 *   - `CentsTally` refuses (throws `CurrencyMismatchError`) to add an amount
 *     whose currency differs from the tally's — the engine sums money only
 *     through it.
 *   - `rateFor` throws `FxRateMissingError` when no rate exists for a pair,
 *     rather than guessing 1:1.
 *   - Formatted money always carries its currency code ("$1,605 CAD").
 */

export const CURRENCIES = ['CAD', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The reporting-currency default (the business is Canadian; CAD is the payment majority). */
export const DEFAULT_REPORTING_CURRENCY: Currency = 'CAD';

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Upper-cases a raw code ('cad' → 'CAD'); null for anything unsupported. */
export function parseCurrency(raw: string | null | undefined): Currency | null {
  const code = (raw ?? '').trim().toUpperCase();
  return isCurrency(code) ? code : null;
}

/** One stored rate: 1 `from` = `rate` `to`, effective from `date` until the next row for the pair. */
export interface FxRate {
  /** YYYY-MM-DD the rate takes effect. */
  date: string;
  from: Currency;
  to: Currency;
  rate: number;
  /** boc | manual | seed */
  source?: string;
}

/** Everything the engine needs to put money into one currency. */
export interface MoneyContext {
  reporting: Currency;
  rates: FxRate[];
  /** Currency GHL opportunity (contract) values are entered in — a location-level fact. */
  contractCurrency: Currency;
  /** Rows the loader dropped because their currency is neither CAD nor USD (data-health). */
  unsupportedRows?: number;
}

export const DEFAULT_MONEY_CONTEXT: MoneyContext = { reporting: DEFAULT_REPORTING_CURRENCY, rates: [], contractCurrency: 'CAD' };

export class CurrencyMismatchError extends Error {
  constructor(expected: Currency, got: string) {
    super(`Refusing to sum ${got} into a ${expected} total — convert to ${expected} first`);
    this.name = 'CurrencyMismatchError';
  }
}

export class FxRateMissingError extends Error {
  constructor(from: Currency, to: Currency, date: string) {
    super(`No ${from}→${to} rate (or its inverse) stored for ${date} — add one in Setup → Currency`);
    this.name = 'FxRateMissingError';
  }
}

/** The latest direct row effective on `date` (or the earliest row, for dates before the table). */
function directRate(rates: FxRate[], from: Currency, to: Currency, date: string): number | null {
  let best: FxRate | null = null;
  let earliest: FxRate | null = null;
  for (const r of rates) {
    if (r.from !== from || r.to !== to || !(r.rate > 0)) continue;
    if (!earliest || r.date < earliest.date) earliest = r;
    if (r.date <= date && (!best || r.date > best.date)) best = r;
  }
  return (best ?? earliest)?.rate ?? null;
}

/**
 * How many `to` one `from` buys on `date`. Only USD→CAD is stored; CAD→USD is
 * derived as its inverse, so a single maintained rate drives both directions.
 */
export function rateFor(rates: FxRate[], from: Currency, to: Currency, date: string): number {
  if (from === to) return 1;
  const direct = directRate(rates, from, to, date);
  if (direct !== null) return direct;
  const inverse = directRate(rates, to, from, date);
  if (inverse !== null) return 1 / inverse;
  throw new FxRateMissingError(from, to, date);
}

/** Integer cents in `from` → integer cents in `to` at `date`'s rate. Identity when the currencies match. */
export function convertCents(cents: number, from: Currency, to: Currency, date: string, rates: FxRate[]): number {
  if (from === to) return cents;
  return Math.round(cents * rateFor(rates, from, to, date));
}

/** A running total that only accepts one currency. */
export class CentsTally {
  private cents = 0;
  constructor(readonly currency: Currency) {}
  add(cents: number, currency: string): this {
    if (currency !== this.currency) throw new CurrencyMismatchError(this.currency, currency);
    this.cents += cents;
    return this;
  }
  get total(): number {
    return this.cents;
  }
}

/** Σ of amounts that must all already be in `currency` (throws otherwise). */
export function sumCents(items: Iterable<{ cents: number; currency: string }>, currency: Currency): number {
  const t = new CentsTally(currency);
  for (const i of items) t.add(i.cents, i.currency);
  return t.total;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** "$1,605 CAD" · "$1,605.50 USD" · compact "$12.3k CAD". Never unlabelled. */
export function formatMoney(cents: number | null, currency: Currency, opts: { compact?: boolean } = {}): string {
  if (cents === null) return '—';
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : '';
  const abs = Math.abs(dollars);
  if (opts.compact && abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k ${currency}`;
  const whole = abs % 1 === 0;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${sign}$${body} ${currency}`;
}

/** A rate as people read it: up to 4 decimals, trailing zeros trimmed (1.36, 0.7353). */
export function formatRate(rate: number): string {
  return String(Number(rate.toFixed(4)));
}

/**
 * Window event fired after the business-wide reporting currency changes
 * (nav toggle / Setup). Every client data hook re-fetches on it, so each
 * number re-renders through the same read-time conversion.
 */
export const CURRENCY_CHANGED_EVENT = 'fitflow:currency-changed';

export function otherCurrency(c: Currency): Currency {
  return c === 'CAD' ? 'USD' : 'CAD';
}

export interface FxNote {
  reporting: Currency;
  /** The non-reporting currency and what one unit of it converts to today. */
  from: Currency;
  rate: number | null;
  /** "displayed in CAD · USD converted at 1.3934 (Bank of Canada, Sep 29)" — the footer / Revenue note. */
  text: string;
  /** boc | manual | seed — where today's rate came from. */
  source?: string | null;
  /** The date of the stored rate row used today. */
  rateDate?: string | null;
}

/** The active-rate note for `today` in the context's reporting currency. */
/** The stored USD↔CAD row effective on `date` (the one rateFor uses), or null. */
export function effectiveRateRow(rates: FxRate[], date: string): FxRate | null {
  let best: FxRate | null = null;
  let earliest: FxRate | null = null;
  for (const r of rates) {
    if (!(r.rate > 0) || !((r.from === 'USD' && r.to === 'CAD') || (r.from === 'CAD' && r.to === 'USD'))) continue;
    if (!earliest || r.date < earliest.date) earliest = r;
    if (r.date <= date && (!best || r.date > best.date)) best = r;
  }
  return best ?? earliest;
}

const SOURCE_LABEL: Record<string, string> = { boc: 'Bank of Canada', manual: 'manual rate', seed: 'placeholder' };

/**
 * The footer line — names the rate AND where it came from and its date (2026-09-30):
 * "displayed in CAD · USD converted at 1.3934 (Bank of Canada, Sep 29)".
 */
export function fxNote(ctx: MoneyContext, today: string): FxNote {
  const from = otherCurrency(ctx.reporting);
  let rate: number | null = null;
  try {
    rate = rateFor(ctx.rates, from, ctx.reporting, today);
  } catch {
    rate = null;
  }
  const row = rate === null ? null : effectiveRateRow(ctx.rates, today);
  const when = row ? new Date(`${row.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
  // A row without a source is not guessed at ("manual"?) — only its date is named.
  const origin = row ? ` (${row.source ? `${SOURCE_LABEL[row.source] ?? row.source}, ` : ''}${when})` : '';
  const text = rate === null ? `displayed in ${ctx.reporting} · no ${from} rate stored` : `displayed in ${ctx.reporting} · ${from} converted at ${formatRate(rate)}${origin}`;
  return { reporting: ctx.reporting, from, rate, text, source: row?.source ?? null, rateDate: row?.date ?? null };
}

// ---------------------------------------------------------------------------
// Seed (migration 0008 writes the same rows)
// ---------------------------------------------------------------------------

/**
 * APPROXIMATE PLACEHOLDER — NOT OFFICIAL RATES. Monthly USD→CAD for 2026,
 * seeded flat at 1.36 so mixed-currency sums are close on day one. Replace
 * with Bank of Canada monthly averages (Setup → Currency) when precision
 * matters; rows carry source='seed' until then.
 */
export const FX_SEED_2026: FxRate[] = Array.from({ length: 12 }, (_, i) => ({
  date: `2026-${String(i + 1).padStart(2, '0')}-01`,
  from: 'USD' as const,
  to: 'CAD' as const,
  rate: 1.36,
  source: 'seed',
}));
