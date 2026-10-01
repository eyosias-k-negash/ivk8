import { describe, it, expect } from 'vitest';
import { bucketKey, monthRange, parseTzOffsetMs } from '../../src/engine/time';
import { utc } from './fixtures';

describe('parseTzOffsetMs', () => {
  it('parses common forms', () => {
    const h3 = 3 * 3600_000;
    expect(parseTzOffsetMs('+03:00')).toBe(h3);
    expect(parseTzOffsetMs('+0300')).toBe(h3);
    expect(parseTzOffsetMs('+3')).toBe(h3);
    expect(parseTzOffsetMs('GMT+3')).toBe(h3);
    expect(parseTzOffsetMs('UTC-05:30')).toBe(-(5.5 * 3600_000));
    expect(parseTzOffsetMs('Z')).toBe(0);
  });
  it('defaults to +03:00', () => {
    expect(parseTzOffsetMs()).toBe(3 * 3600_000);
  });
  it('rejects garbage', () => {
    expect(() => parseTzOffsetMs('Mars/Olympus')).toThrow();
    expect(() => parseTzOffsetMs('+25:00')).toThrow();
  });
});

describe('bucketKey: timezone boundaries (most likely bug source)', () => {
  // 22:30 UTC on Aug 31 is 01:30 on Sep 1 at +03:00
  const t = utc('2026-08-31T22:30:00Z');
  it('lands in September at +03:00 but August at UTC', () => {
    expect(bucketKey(t, 'MONTH', '+03:00')).toBe('2026-09');
    expect(bucketKey(t, 'MONTH', 'Z')).toBe('2026-08');
    expect(bucketKey(t, 'DAY', '+03:00')).toBe('2026-09-01');
  });
  it('year rolls over at local midnight', () => {
    expect(bucketKey(utc('2026-12-31T21:00:00Z'), 'YEAR', '+03:00')).toBe('2027');
    expect(bucketKey(utc('2026-12-31T21:00:00Z'), 'YEAR', 'Z')).toBe('2026');
  });
  it('weeks start Monday (2026-09-06 is a Sunday -> week of 2026-08-31)', () => {
    expect(bucketKey(utc('2026-09-06T12:00:00Z'), 'WEEK', 'Z')).toBe('2026-08-31');
    expect(bucketKey(utc('2026-09-07T12:00:00Z'), 'WEEK', 'Z')).toBe('2026-09-07');
  });
});

describe('monthRange', () => {
  it('computes local month bounds and day info', () => {
    const r = monthRange(utc('2026-09-15T10:00:00Z'), '+03:00');
    expect(r.startMs).toBe(utc('2026-08-31T21:00:00Z')); // Sep 1 00:00 at +03:00
    expect(r.endMs).toBe(utc('2026-09-30T21:00:00Z')); // Oct 1 00:00 at +03:00
    expect(r.daysInMonth).toBe(30);
    expect(r.dayOfMonth).toBe(15);
  });
  it('handles February in a leap year', () => {
    expect(monthRange(utc('2028-02-10T00:00:00Z'), 'Z').daysInMonth).toBe(29);
  });
});
