/**
 * Currency conversion core (pure). Fetching lives in src/rates/rateService.ts.
 *
 * Convention: rateToBase = how many BASE units one unit of `currency` is worth.
 * Example with base ETB: { currency: 'USD', rateToBase: 130.5 } means 1 USD = 130.5 ETB.
 */
export type RateSource = 'manual' | 'live' | 'fallback' | 'unavailable';

export interface RateEntry {
  currency: string;
  rateToBase: number | null;
  source: RateSource;
  fetchedAt?: string;
  /** Served from the last good snapshot because the refresh failed. */
  stale?: boolean;
}

export type RateTable = Map<string, RateEntry>;

/** Manual overrides: { USD: 130.5 }. Non-positive or non-finite values are rejected. */
export type RateOverrides = Record<string, number>;

export function applyOverrides(rates: RateTable, overrides: RateOverrides = {}): RateTable {
  const out: RateTable = new Map(rates);
  for (const [currency, rate] of Object.entries(overrides)) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid manual rate for ${currency}: ${rate}`);
    }
    out.set(currency, { currency, rateToBase: rate, source: 'manual' });
  }
  return out;
}

/**
 * Convert to base currency. Returns null when the rate is unavailable so callers
 * can report the currency as unconverted instead of silently dropping or mixing it.
 */
export function toBase(
  amount: number,
  currency: string | null | undefined,
  baseCurrency: string,
  rates: RateTable,
): number | null {
  const cur = currency || baseCurrency;
  if (cur === baseCurrency) return amount;
  const entry = rates.get(cur);
  if (!entry || entry.rateToBase == null) return null;
  return amount * entry.rateToBase;
}

/** Derive X->base from EUR-quoted rates (ECB style): base per X = eurToBase / eurToX. */
export function crossRateViaEur(eurToX: number, eurToBase: number): number {
  return eurToBase / eurToX;
}
