import { describe, it, expect } from 'vitest';
import { fmtDate, offsetMs } from './format';
import { analyticsQuery } from './api/client';

describe('format', () => {
  it('renders in the selected offset, not the browser zone', () => {
    expect(fmtDate(Date.parse('2026-09-30T22:30:00Z'), '+03:00')).toBe('2026-10-01 01:30');
    expect(offsetMs('-05:30')).toBe(-330 * 60_000);
  });
});

describe('analyticsQuery', () => {
  it('omits empty overrides and encodes non-empty ones', () => {
    expect(analyticsQuery({ tz: '+03:00', rateOverrides: {} })).toBe('tz=%2B03%3A00');
    expect(new URLSearchParams(analyticsQuery({ tz: 'Z', rateOverrides: { USD: 130 } })).get('rateOverrides')).toBe('{"USD":130}');
  });
});
