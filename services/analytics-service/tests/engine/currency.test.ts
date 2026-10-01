import { describe, it, expect } from 'vitest';
import { applyOverrides, crossRateViaEur, toBase, type RateTable } from '../../src/engine/currency';

const live: RateTable = new Map([
  ['USD', { currency: 'USD', rateToBase: 120, source: 'live', fetchedAt: '2026-10-01T00:00:00Z' }],
  ['KES', { currency: 'KES', rateToBase: null, source: 'unavailable' }],
]);

describe('toBase', () => {
  it('base currency and missing currency pass through', () => {
    expect(toBase(50, 'ETB', 'ETB', live)).toBe(50);
    expect(toBase(50, null, 'ETB', live)).toBe(50);
  });
  it('converts with rateToBase', () => {
    expect(toBase(10, 'USD', 'ETB', live)).toBe(1200);
  });
  it('returns null (not 0, not raw) for unavailable or unknown currencies', () => {
    expect(toBase(10, 'KES', 'ETB', live)).toBeNull();
    expect(toBase(10, 'XYZ', 'ETB', live)).toBeNull();
  });
});

describe('applyOverrides', () => {
  it('manual rate wins over live and is marked manual', () => {
    const t = applyOverrides(live, { USD: 130.5 });
    expect(t.get('USD')).toMatchObject({ rateToBase: 130.5, source: 'manual' });
    expect(toBase(10, 'USD', 'ETB', t)).toBeCloseTo(1305);
  });
  it('can make an unavailable currency convertible', () => {
    const t = applyOverrides(live, { KES: 0.9 });
    expect(toBase(100, 'KES', 'ETB', t)).toBeCloseTo(90);
  });
  it('does not mutate the original table', () => {
    applyOverrides(live, { USD: 1 });
    expect(live.get('USD')?.rateToBase).toBe(120);
  });
  it('rejects non-positive / non-finite rates', () => {
    expect(() => applyOverrides(live, { USD: 0 })).toThrow();
    expect(() => applyOverrides(live, { USD: -1 })).toThrow();
    expect(() => applyOverrides(live, { USD: NaN })).toThrow();
  });
});

describe('crossRateViaEur', () => {
  it('derives base-per-X from EUR quotes', () => {
    // EUR->USD 1.10, EUR->ETB 132  =>  1 USD = 120 ETB
    expect(crossRateViaEur(1.1, 132)).toBeCloseTo(120);
  });
});
